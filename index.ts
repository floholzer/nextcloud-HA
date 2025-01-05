import * as pulumi from "@pulumi/pulumi";
import * as azure from "@pulumi/azure-native";

// Configs
const loadBalancerName = "nextcloud-lb";
const FE_IP_NAME = "FrontendIPConfig";
const BE_POOLS_NAME = "BackEndPools";

// 1. Ressourcengruppe erstellen
const resourceGroup = new azure.resources.ResourceGroup("nextcloud-rg");

// 2. Storage-Konto erstellen
const storageAccount = new azure.storage.StorageAccount("nextcloudstorage", {
    resourceGroupName: resourceGroup.name,
    sku: {
        name: "Standard_LRS",
    },
    kind: "StorageV2",
    location: resourceGroup.location,
});

// 3. Dateifreigabe erstellen
const fileShare = new azure.storage.FileShare("nextcloudshare", {
    resourceGroupName: resourceGroup.name,
    accountName: storageAccount.name,
    shareName: "nextcloud",
});

// 4. Speicheraccount-Schlüssel abrufen
const storageAccountKeys = pulumi.all([resourceGroup.name, storageAccount.name]).apply(([rgName, accountName]) =>
    azure.storage.listStorageAccountKeys({resourceGroupName: rgName, accountName: accountName})
);
const primaryStorageKey = storageAccountKeys.keys[0].value;

// 5. Virtuelles Netzwerk und Subnetz erstellen
const virtualNetwork = new azure.network.VirtualNetwork("nextcloud-vnet", {
    resourceGroupName: resourceGroup.name,
    addressSpace: {addressPrefixes: ["10.0.0.0/16"]},
});

const subnet = new azure.network.Subnet("nextcloud-subnet", {
    resourceGroupName: resourceGroup.name,
    virtualNetworkName: virtualNetwork.name,
    addressPrefix: "10.0.1.0/24",
});

// 6. Öffentliche IP-Adresse und Load Balancer erstellen
const publicIp = new azure.network.PublicIPAddress("nextcloud-pip", {
    resourceGroupName: resourceGroup.name,
    publicIPAllocationMethod: "Static",
    sku: {name: "Standard"},
});

const loadBalancer = new azure.network.LoadBalancer(loadBalancerName, {
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
        protocol: azure.network.ProbeProtocol.Http,
        requestPath: "/",
    }],
    loadBalancingRules: [{
        backendPort: 80,
        enableFloatingIP: false,
        frontendPort: 80,
        idleTimeoutInMinutes: 5,
        loadDistribution: azure.network.LoadDistribution.Default,
        protocol: azure.network.TransportProtocol.Tcp,
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

// 7. Virtual Machine Scale Set definieren
const vmss = new azure.compute.VirtualMachineScaleSet("nextcloud-vmss", {
    resourceGroupName: resourceGroup.name,
    sku: {
        name: "Standard_DS1_v2",
        tier: "Standard",
        capacity: 2,
    },
    upgradePolicy: {mode: "Automatic"},
    virtualMachineProfile: {
        osProfile: {
            computerNamePrefix: "nextcloudvm",
            adminUsername: "adminuser",
            adminPassword: "Password1234!",
        },
        storageProfile: {
            imageReference: {
                publisher: "Canonical",
                offer: "UbuntuServer",
                sku: "18.04-LTS",
                version: "latest",
            },
            osDisk: {
                createOption: "FromImage",
                managedDisk: {storageAccountType: "Standard_LRS"},
            },
        },
        networkProfile: {
            networkInterfaceConfigurations: [{
                name: "nextcloud-nic",
                primary: true,
                ipConfigurations: [{
                    name: "nextcloud-ipconfig",
                    subnet: {id: subnet.id},
                    loadBalancerBackendAddressPools: [{id: backendAddressPool.id}],
                }],
            }],
        },
        // Benutzerdefinierte Skripterweiterung für die Installation von Nextcloud und das Mounten der Dateifreigabe
        extensionProfile: {
            extensions: [{
                name: "nextcloud-setup-script",
                properties: {
                    publisher: "Microsoft.Azure.Extensions",
                    type: "CustomScript",
                    typeHandlerVersion: "2.0",
                    autoUpgradeMinorVersion: true,
                    settings: {
                        fileUris: ["https://example.com/setup-nextcloud.sh"], // URL zum Setup-Skript
                        commandToExecute: pulumi.interpolate`bash setup-nextcloud.sh ${storageAccount.name} ${primaryStorageKey}`,
                    },
                },
            }],
        },
    },
    overprovision: true,
});

// 8. Automatische Skalierungsregeln konfigurieren
const autoscale = new azure.monitor.AutoscaleSetting("nextcloud-autoscale", {
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
