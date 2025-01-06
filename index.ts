const pulumi = require("@pulumi/pulumi");
const azure = require("@pulumi/azure-native");
const azure_native = require("@pulumi/azure-native");

// Configs
const loadBalancerName = "nextcloud-lb";
const FE_IP_NAME = "FrontendIPConfig";
const BE_POOLS_NAME = "BackEndPools";
const location = "northeurope";
const ownerSubscriptionID = azure.config.subscriptionId;

console.log("Loaded Subscription ID:", ownerSubscriptionID);

// 1. Ressourcengruppe erstellen
const resourceGroup = new azure_native.resources.ResourceGroup("nextcloud-rg", {
    location: location,
});
// 2. Storage-Konto erstellen
const storageAccount = new azure_native.storage.StorageAccount("nextcloudstorage", {
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    sku: {name: azure_native.storage.SkuName.Standard_LRS},
    kind: azure_native.storage.Kind.StorageV2,
});

// 3. Dateifreigabe erstellen
const fileShare = new azure_native.storage.FileShare("nextcloudshare", {
    resourceGroupName: resourceGroup.name,
    accountName: storageAccount.name,
    enabledProtocols: azure_native.storage.EnabledProtocols.SMB,
    shareName: "nextcloud",
});
// 4. Speicheraccount-Schlüssel abrufen
const storageAccountKeys = pulumi
    .all([resourceGroup.name, storageAccount.name])
    .apply(([rgName, accountName]: [string, string]) =>
        azure_native.storage.listStorageAccountKeys({
            resourceGroupName: rgName,
            accountName: accountName,
        })
    );
const primaryStorageKey = storageAccountKeys.keys[0].value;


// 5. Virtuelles Netzwerk erstellen
const vnet = new azure_native.network.VirtualNetwork("nextcloud-vnet", {
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    addressSpace: {addressPrefixes: ["10.0.0.0/16"]},
});

// Network Security Group (NSG) erstellen
const nsg = new azure_native.network.NetworkSecurityGroup("nextcloud-nsg", {
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
});

// Subnetz erstellen und NSG direkt verknüpfen
const subnet = new azure_native.network.Subnet("nextcloud-subnet", {
    resourceGroupName: resourceGroup.name,
    virtualNetworkName: vnet.name,
    addressPrefix: "10.0.1.0/24", // Erstes Subnetz
    networkSecurityGroup: {
        id: nsg.id, // Verknüpfe das NSG direkt
    },
});

// Inbound-Regel für Port 80 in der NSG erstellen
const allowHttpRule = new azure_native.network.SecurityRule("allow-http", {
    resourceGroupName: resourceGroup.name,
    networkSecurityGroupName: nsg.name,
    priority: 100,
    direction: "Inbound",
    access: "Allow",
    protocol: "*",
    sourcePortRange: "*",
    destinationPortRanges: ["80","22","3389"],
    sourceAddressPrefix: "*",
    destinationAddressPrefix: "*",
});

// Default-Regel zum Verweigern von allem anderen erstellen
const denyAllRule = new azure_native.network.SecurityRule("deny-all", {
    resourceGroupName: resourceGroup.name,
    networkSecurityGroupName: nsg.name,
    priority: 200,
    direction: "Inbound",
    access: "Deny",
    protocol: "*",
    sourcePortRange: "*",
    destinationPortRange: "*",
    sourceAddressPrefix: "*",
    destinationAddressPrefix: "*",
});

// 6. Öffentliche IP-Adresse und Load Balancer erstellen
const publicIp = new azure_native.network.PublicIPAddress("nextcloud-pip", {
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    publicIPAllocationMethod: "Static",
    sku: {
        name: "Standard",
    },
});

const loadBalancer = new azure_native.network.LoadBalancer(loadBalancerName, {
    loadBalancerName: loadBalancerName,
    resourceGroupName: resourceGroup.name,
    location: resourceGroup.location,
    sku: {
        name: "Standard"
    },
    frontendIPConfigurations: [{
        name: FE_IP_NAME,
        publicIPAddress: {id: publicIp.id},
    }],
    backendAddressPools: [{
        name: BE_POOLS_NAME,
    }],
    probes: [{
        intervalInSeconds: 15,
        name: "probe-lb",
        numberOfProbes: 2,
        port: 80,
        probeThreshold: 1,
        protocol: "Http",
        requestPath: "/",
    }],
    loadBalancingRules: [{
        backendPort: 80,
        enableFloatingIP: false,
        frontendPort: 80,
        idleTimeoutInMinutes: 15,
        loadDistribution: "Default",
        protocol: "Tcp",
        name: "rulelb",
        backendAddressPool: {
            id: pulumi.interpolate`/subscriptions/${ownerSubscriptionID}/resourceGroups/${resourceGroup.name}/providers/Microsoft.Network/loadBalancers/${loadBalancerName}/backendAddressPools/${BE_POOLS_NAME}`,
        },
        frontendIPConfiguration: {
            id: pulumi.interpolate`/subscriptions/${ownerSubscriptionID}/resourceGroups/${resourceGroup.name}/providers/Microsoft.Network/loadBalancers/${loadBalancerName}/frontendIPConfigurations/${FE_IP_NAME}`,
        },
        probe: {
            id: pulumi.interpolate`/subscriptions/${ownerSubscriptionID}/resourceGroups/${resourceGroup.name}/providers/Microsoft.Network/loadBalancers/${loadBalancerName}/probes/probe-lb`,
        },
    }],
});

const init_script = "#!/bin/bash\n" +
    "# Install Dependencies\n" +
    "sudo apt-get update\n" +
    "sudo apt install -y apt-transport-https ca-certificates curl software-properties-common\n" +
    "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -\n" +
    "sudo add-apt-repository \"deb [arch=amd64] https://download.docker.com/linux/ubuntu focal stable\"\n" +
    "sudo apt install -y docker-ce\n" +
    "sudo mkdir /mnt/nextcloud\n" +
    "# Run Nextcloud Container\n" +
    "sudo docker run --init --restart always -d -p 80:80 -e TRUSTED_PROXIES='"+publicIp.ipAddress+"' -v /mnt/nextcloud/nextcloud:/var/www/html -v /mnt/nextcloud/custom_apps:/var/www/html/custom_apps -v /mnt/nextcloud/config:/var/www/html/config -v /mnt/nextcloud/data:/var/www/html/data nextcloud:30.0.4-apache\n"+
    "# Mount Azure FileShare\n" +
    "if [ ! -d \"/etc/smbcredentials\" ]; then\n" +
    "sudo mkdir /etc/smbcredentials\n" +
    "fi\n" +
    "if [ ! -f \"/etc/smbcredentials/"+storageAccount.name+".cred\" ]; then\n" +
    "   sudo bash -c 'echo \"username="+storageAccount.name+"\" >> /etc/smbcredentials/"+storageAccount.name+".cred'\n" +
    "   sudo bash -c 'echo \"password="+primaryStorageKey+"\" >> /etc/smbcredentials/"+storageAccount.name+".cred'\n" +
    "fi\n" +
    "sudo chmod 600 /etc/smbcredentials/"+storageAccount.name+".cred\n" +
    "sudo bash -c 'echo \"//"+storageAccount.name+".file.core.windows.net/nextcloud /mnt/nextcloud cifs nofail,credentials=/etc/smbcredentials/"+storageAccount.name+".cred,dir_mode=0777,file_mode=0777,serverino,nosharesock,actimeo=30\" >> /etc/fstab'\n" +
    "sudo mount -t cifs //"+storageAccount.name+".file.core.windows.net/nextcloud /mnt/nextcloud -o credentials=/etc/smbcredentials/"+storageAccount.name+".cred,dir_mode=0777,file_mode=0777,serverino,nosharesock,actimeo=30\n";

// 7. Virtual Machine Scale Set definieren
const vmss = new azure_native.compute.VirtualMachineScaleSet("nextcloud-vmss", {
    location: resourceGroup.location,
    resourceGroupName: resourceGroup.name,
    sku: {
        name: "Standard_DS2_v2",
        tier: "Standard",
        capacity: 1,
    },
    upgradePolicy: {
        mode: "Automatic"
    },
    virtualMachineProfile: {
        osProfile: {
            computerNamePrefix: "nextcloudvm-",
            adminUsername: "adminuser",
            adminPassword: "Password1234!",
            customData: Buffer.from(init_script).toString("base64"),
        },
        storageProfile: {
            imageReference: {
                publisher: "Canonical",
                offer: "ubuntu-24_04-lts",
                sku: "server",
                version: "latest",
            },
            osDisk: {
                createOption: "FromImage",
                managedDisk: {storageAccountType: "Standard_LRS"},
            },
            dataDisks: [
                {
                    lun: 0,
                    createOption: "Empty",
                    diskSizeGB: 1024,
                    managedDisk: {
                        storageAccountType: "Standard_LRS",
                    },
                },
            ],
        },
        networkProfile: {
            networkInterfaceConfigurations: [{
                name: "nextcloud-nic",
                primary: true,
                ipConfigurations: [{
                    name: "nextcloud-ipconfig",
                    subnet: {id: subnet.id},
                    loadBalancerBackendAddressPools: [{
                        id: pulumi.interpolate`${loadBalancer.id}/backendAddressPools/${BE_POOLS_NAME}`,
                    }],
                }],
                networkSecurityGroup: {id: nsg.id},
            }],
        },
    },
});

// 8. Automatische Skalierungsregeln konfigurieren
const autoscale = new azure_native.insights.AutoscaleSetting("nextcloud-autoscale", {
    location: resourceGroup.location,
    resourceGroupName: resourceGroup.name,
    targetResourceUri: vmss.id,
    profiles: [{
        name: "autoscale-cpu",
        capacity: {
            minimum: "1",
            maximum: "5",
            default: "2",
        },
        rules: [
            {
                metricTrigger: {
                    metricName: "Percentage CPU",
                    metricResourceUri: vmss.id,
                    timeGrain: "PT1M",
                    statistic: "Average",
                    timeWindow: "PT5M",
                    timeAggregation: "Average",
                    operator: "GreaterThan",
                    threshold: 75,
                },
                scaleAction: {
                    direction: "Increase",
                    type: "ChangeCount",
                    value: "1",
                    cooldown: "PT5M",
                },
            },
            {
                metricTrigger: {
                    metricName: "Percentage CPU",
                    metricResourceUri: vmss.id,
                    timeGrain: "PT1M",
                    statistic: "Average",
                    timeWindow: "PT5M",
                    timeAggregation: "Average",
                    operator: "LessThan",
                    threshold: 25,
                },
                scaleAction: {
                    direction: "Decrease",
                    type: "ChangeCount",
                    value: "1",
                    cooldown: "PT5M",
                },
            },
        ],
    }],
    enabled: true,
});

// 9. Öffentliche IP-Adresse des Load Balancers exportieren
export const publicIpAddress = publicIp.ipAddress;