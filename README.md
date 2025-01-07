# Nextcloud Deployment with Pulumi and Azure

This project automates the deployment of a Nextcloud instance on Azure using Pulumi. It sets up the necessary Azure resources, including a resource group, storage account, virtual network, network security group, load balancer, and a virtual machine scale set.

## Prerequisites

- Node.js and npm installed
- Pulumi CLI installed
- Azure CLI installed and authenticated
- An active Azure subscription

## Project Structure

- `index.ts`: Main Pulumi script to define and deploy Azure resources.

## Setup

1. **Install Dependencies**

   ```bash
   npm install
   ```

2. **Configure Pulumi**

   Login to Pulumi and select your stack:

   ```bash
   pulumi login
   pulumi stack select <your-stack-name>
   ```

3. **Set Azure Configuration**

   Set the Azure region and subscription ID:

   ```bash
   pulumi config set azure:location northeurope
   pulumi config set azure:subscriptionId <your-subscription-id>
   ```

## Deployment

To deploy the resources, run:

```bash
pulumi up
```

Review the changes and confirm the deployment.

## Resources Created

- **Resource Group**: `nextcloud-rg`
- **Storage Account**: `nextcloudstorage`
- **File Share**: `nextcloudshare`
- **Virtual Network**: `nextcloud-vnet`
- **Network Security Group**: `nextcloud-nsg`
- **Subnet**: `nextcloud-subnet`
- **Public IP Address**: `nextcloud-pip`
- **Load Balancer**: `nextcloud-lb`
- **Virtual Machine Scale Set**: `nextcloud-vmss`
- **Autoscale Settings**: `nextcloud-autoscale`

## Cleanup

To remove all resources, run:

```bash
pulumi destroy
```

## Notes

- The VM scale set is configured to automatically scale based on CPU usage.
- The Nextcloud instance is deployed in a Docker container on the VM scale set.
- The storage account keys are used to mount the Azure File Share to the VM instances.