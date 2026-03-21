import boto3
from dotenv import load_dotenv
import os

# Load environment variables
load_dotenv()

# Get credentials from environment
access_key = os.getenv("AWS_ACCESS_KEY_ID")
secret_key = os.getenv("AWS_SECRET_ACCESS_KEY")
region = os.getenv("AWS_REGION")

print(f"Testing AWS credentials...")
print(f"Access Key ID: {access_key[:4]}...{access_key[-4:]}")
print(f"Region: {region}")

try:
    # Create a Pricing API client (must use us-east-1)
    pricing = boto3.client(
        'pricing',
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name='us-east-1'  # Pricing API is only available in us-east-1
    )
    
    # Try to get a simple price query
    response = pricing.get_products(
        ServiceCode='AmazonEC2',
        Filters=[
            {'Type': 'TERM_MATCH', 'Field': 'instanceType', 'Value': 't3.micro'},
            {'Type': 'TERM_MATCH', 'Field': 'operatingSystem', 'Value': 'Linux'},
            {'Type': 'TERM_MATCH', 'Field': 'tenancy', 'Value': 'Shared'},
            {'Type': 'TERM_MATCH', 'Field': 'termType', 'Value': 'OnDemand'}
        ],
        FormatVersion='aws_v1',
        MaxResults=1
    )
    
    print("\nSuccess! Your credentials are valid and have access to the Pricing API.")
    print("Response received from AWS Pricing API.")
        
except Exception as e:
    print(f"\nError testing credentials: {str(e)}") 