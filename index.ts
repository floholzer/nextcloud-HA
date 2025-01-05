const pulumi = require("@pulumi/pulumi");
const azure_native = require("@pulumi/azure-native");

// Configs
const loadBalancerName = "nextcloud-lb";
const FE_IP_NAME = "FrontendIPConfig";
const BE_POOLS_NAME = "BackEndPools";
const resourceGroupName = "clco_project2";
const location = "northeurope";
const ownerSubscriptionID = "baf14dc0-aa90-480a-a428-038a6943c5b3";

// 1. Ressourcengruppe erstellen
const resourceGroup = new azure_native.resources.ResourceGroup(resourceGroupName, {
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
    direction: azure_native.network.SecurityRuleDirection.Inbound,
    access: azure_native.network.SecurityRuleAccess.Allow,
    protocol: "*",
    sourcePortRange: "*",
    destinationPortRange: "8080",
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
    publicIPAllocationMethod: azure_native.network.IpAllocationMethod.Static,
    sku: {name: azure_native.network.PublicIPAddressSkuName.Standard},
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
        protocol: azure_native.network.ProbeProtocol.Http,
        requestPath: "/",
    }],
    loadBalancingRules: [{
        backendPort: 80,
        enableFloatingIP: false,
        frontendPort: 80,
        idleTimeoutInMinutes: 5,
        loadDistribution: azure_native.network.LoadDistribution.Default,
        protocol: azure_native.network.TransportProtocol.Tcp,
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

const init_script = pulumi.interpolate(`#!/bin/bash
STORAGE_ACCOUNT_NAME=${storageAccount.name}
STORAGE_ACCOUNT_KEY=${primaryStorageKey}
FILE_SHARE_NAME=${fileShare.name}
MOUNT_POINT=/mnt/nextcloud

sudo apt-get update
sudo apt-get install -y cifs-utils docker-ce docker-ce-cli containerd.io

sudo mkdir -p $MOUNT_POINT

echo "username=$STORAGE_ACCOUNT_NAME" | sudo tee /etc/smbcredentials
echo "password=$STORAGE_ACCOUNT_KEY" | sudo tee -a /etc/smbcredentials
sudo chmod 600 /etc/smbcredentials

sudo mount -t cifs //$STORAGE_ACCOUNT_NAME.file.core.windows.net/$FILE_SHARE_NAME $MOUNT_POINT -o credentials=/etc/smbcredentials,serverino

echo "//$STORAGE_ACCOUNT_NAME.file.core.windows.net/$FILE_SHARE_NAME $MOUNT_POINT cifs credentials=/etc/smbcredentials,serverino 0 0" | sudo tee -a /etc/fstab
`);

// 7. Virtual Machine Scale Set definieren
const vmss = new azure_native.compute.VirtualMachineScaleSet("nextcloud-vmss", {
    location: resourceGroup.location,
    resourceGroupName: resourceGroup.name,
    sku: {
        name: "Standard_DS1_v2",
        tier: "Standard",
        capacity: 3,
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
            }],
        },
    },
    overprovision: true,
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
