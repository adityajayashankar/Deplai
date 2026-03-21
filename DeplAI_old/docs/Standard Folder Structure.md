Industry-Standard Terraform Folder Structure

project-folder/
├── main.tf                 # Core infrastructure resources (e.g., EC2, S3)
├── variables.tf            # Input variable declarations
├── outputs.tf              # Output values (e.g., IPs, resource IDs)
├── providers.tf            # Provider configurations (e.g., AWS, Azure)
├── backend.tf              # Remote state storage configuration (e.g., S3, Terraform Cloud)
├── versions.tf             # Terraform and provider version constraints
├── data.tf                 # Data sources to fetch existing resources
├── iam.tf                  # IAM policies, roles, and permissions
├── security_groups.tf      # Security group rules for network traffic
├── networking.tf           # VPC, subnets, and networking configurations
├── terraform.tfstate       # Terraform state file (auto-generated, do not edit)
├── .terraform/             # Terraform cache directory (auto-generated)
├── modules/                # Reusable modules for common infrastructure patterns
│   ├── vpc/                # Example module for VPC
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   └── ec2/                # Example module for EC2 instances
│       ├── main.tf
│       ├── variables.tf
│       └── outputs.tf
├── environments/           # Environment-specific configurations
│   ├── dev/                # Development environment
│   │   ├── terraform.tfvars # Variable values for dev
│   │   └── backend.tfvars   # Backend config for dev (if needed)
│   ├── staging/            # Staging environment
│   │   ├── terraform.tfvars # Variable values for staging
│   │   └── backend.tfvars   # Backend config for staging (if needed)
│   └── prod/               # Production environment
│       ├── terraform.tfvars # Variable values for prod
│       └── backend.tfvars   # Backend config for prod (if needed)
├── README.md               # Project documentation and usage instructions
├── terraform.tfvars.example # Example variable file for guidance
└── Jenkinsfile             # CI/CD pipeline configuration (e.g., Jenkins, GitLab CI)
