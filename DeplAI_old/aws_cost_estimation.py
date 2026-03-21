import boto3
import json
import os
from dotenv import load_dotenv
from logger import setup_logger # Import the custom logger

# Initialize logger for this module
logger = setup_logger(name="CostEstimator")

# Load credentials from .env
load_dotenv()
AWS_ACCESS_KEY = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
logger.info(f"AWS_ACCESS_KEY Loaded: {'Yes' if AWS_ACCESS_KEY else 'No'}")
logger.info(f"AWS_SECRET_KEY Loaded: {'Yes' if AWS_SECRET_KEY else 'No'}")

REGION_CODE_MAP = {
                  "US East (N. Virginia)": "us-east-1",
                  "US East (Ohio)": "us-east-2",
                  "US West (N. California)": "us-west-1",
                  "US West (Oregon)": "us-west-2",
                  "Africa (Cape Town)": "af-south-1",
                  "Asia Pacific (Hong Kong)": "ap-east-1",
                  "Asia Pacific (Hyderabad)": "ap-south-2",
                  "Asia Pacific (Jakarta)": "ap-southeast-3",
                  "Asia Pacific (Melbourne)": "ap-southeast-4",
                  "Asia Pacific (Mumbai)": "ap-south-1",
                  "Asia Pacific (Osaka)": "ap-northeast-3",
                  "Asia Pacific (Seoul)": "ap-northeast-2",
                  "Asia Pacific (Singapore)": "ap-southeast-1",
                  "Asia Pacific (Sydney)": "ap-southeast-2",
                  "Asia Pacific (Tokyo)": "ap-northeast-1",
                  "Canada (Central)": "ca-central-1",
                  "Europe (Frankfurt)": "eu-central-1",
                  "Europe (Ireland)": "eu-west-1",
                  "Europe (London)": "eu-west-2",
                  "Europe (Milan)": "eu-south-1",
                  "Europe (Paris)": "eu-west-3",
                  "Europe (Spain)": "eu-south-2",
                  "Europe (Stockholm)": "eu-north-1",
                  "Europe (Zurich)": "eu-central-2",
                  "Middle East (Bahrain)": "me-south-1",
                  "Middle East (UAE)": "me-central-1",
                  "South America (São Paulo)": "sa-east-1",
                  "AWS GovCloud (US-East)": "us-gov-east-1",
                  "AWS GovCloud (US-West)": "us-gov-west-1"
                }

REGION_USAGE_TYPE_PREFIX = {
                              "ap-south-1": "APS3", # Mumbai
                              "ap-southeast-1": "APS1", # Singapore
                              "us-east-1": "USE1", # N. Virginia
                              "us-west-2": "USW2", # Oregon
                            }


def create_pricing_client():
    return boto3.client(
        'pricing',
        region_name='us-east-1',  # Pricing API is only in us-east-1
        aws_access_key_id=AWS_ACCESS_KEY,
        aws_secret_access_key=AWS_SECRET_KEY
    )

def get_rds_cost_estimate(pricing_client,architecture_json):

    # Find RDS node
    rds_node = next((node for node in architecture_json['nodes'] if node['type'] == 'AmazonRDS'), None)
    if not rds_node:
        raise ValueError("No AmazonRDS node found in the architecture JSON.")

    region_friendly = rds_node['region']
    aws_region = REGION_CODE_MAP.get(region_friendly)
    if not aws_region:
        raise ValueError(f"Region '{region_friendly}' not mapped to AWS region code.")

    attributes = rds_node['attributes']
    instance_type = attributes['instanceType']
    db_engine = attributes['databaseEngine'].lower()
    term_type = attributes['termType']
    storage_gb = attributes['storageGB']
    storage_type = attributes['storageType']

    # Fetch RDS Instance Price 
    instance_filters = [
        {"Type": "TERM_MATCH", "Field": "instanceType", "Value": instance_type},
        {"Type": "TERM_MATCH", "Field": "databaseEngine", "Value": db_engine},
        {"Type": "TERM_MATCH", "Field": "deploymentOption", "Value": "Single-AZ"},
        {"Type": "TERM_MATCH", "Field": "regionCode", "Value": aws_region},
        {"Type": "TERM_MATCH", "Field": "termType", "Value": term_type},
        {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Database Instance"},
    ]

    instance_price_response = pricing_client.get_products(
        ServiceCode='AmazonRDS',
        Filters=instance_filters,
        MaxResults=1
    )

    if not instance_price_response['PriceList']:
        raise ValueError("Could not fetch RDS instance pricing info.")

    price_item = json.loads(instance_price_response['PriceList'][0])

    # Get correct term level (e.g., "OnDemand" or "Reserved")
    term_type_key = list(price_item["terms"].keys())[0]  # usually 'OnDemand'
    term_data_map = price_item["terms"][term_type_key]
    first_term_id = next(iter(term_data_map))  # grab the first SKU id under OnDemand
    logger.debug(f"First SKU code for RDS instance: {first_term_id}")
    term_data = term_data_map[first_term_id]

    # Now get the price
    if "priceDimensions" not in term_data:
        raise ValueError("priceDimensions not found in RDS term data.")

    price_dimension = next(iter(term_data["priceDimensions"].values()))
    instance_price_per_hour = float(price_dimension["pricePerUnit"]["USD"])

    instance_price_per_hour = float(price_dimension['pricePerUnit']['USD'])
    monthly_instance_cost = round(instance_price_per_hour * 730, 4)

    #  Fetch RDS Storage Price 
    storage_filters = [
        {"Type": "TERM_MATCH", "Field": "serviceCode", "Value": "AmazonRDS"},
        {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Database Storage"},
        {"Type": "TERM_MATCH", "Field": "regionCode", "Value": aws_region},
        {"Type": "TERM_MATCH", "Field": "volumeType", "Value": "General Purpose"},
        {"Type": "TERM_MATCH", "Field": "databaseEngine", "Value": db_engine},
        {"Type": "TERM_MATCH", "Field": "deploymentOption", "Value": "Single-AZ"},
         ]

    storage_price_response = pricing_client.get_products(
        ServiceCode='AmazonRDS',
        Filters=storage_filters,
        MaxResults=1
    )


    if not storage_price_response['PriceList']:
        raise ValueError("Could not fetch RDS storage pricing info.")

    storage_item = json.loads(storage_price_response['PriceList'][0])
    storage_term_data = next(iter(storage_item['terms']['OnDemand'].values()))
    storage_price_dimension = next(iter(storage_term_data['priceDimensions'].values()))
    storage_price_per_gb = float(storage_price_dimension['pricePerUnit']['USD'])
    monthly_storage_cost = round(storage_price_per_gb * storage_gb, 4)

    # --- 3. Total Cost ---
    total_rds_monthly_cost = round(monthly_instance_cost + monthly_storage_cost, 4)

    logger.info(f"RDS_Monthly_Instance_cost= {monthly_instance_cost}")
    logger.info(f"RDS_Monthly_Storage_cost= {monthly_storage_cost}")
    logger.info(f"Total_RDS_Monthly_cost= {total_rds_monthly_cost}")
    logger.info("--------------------------------------------------------------------")
    return {
        "rds_instance_monthly_usd": monthly_instance_cost,
        "rds_storage_monthly_usd": monthly_storage_cost,
        "rds_total_monthly_usd": total_rds_monthly_cost
    }

def get_ec2_cost_estimate(pricing_client, architecture_json):
  #  Find EC2 node 
        ec2_node = next((node for node in architecture_json['nodes'] if node['type'] == 'AmazonEC2'), None)
        if not ec2_node:
            raise ValueError("No AmazonEC2 node found in the architecture JSON.")

        region_friendly = ec2_node['region']
        region = region_friendly  # For EC2 pricing API, region is used as location (full name)

        attributes = ec2_node['attributes']
        instance_type = attributes.get("instanceType", "t3.micro")
        operating_system = attributes.get("operatingSystem", "Linux")
        tenancy = attributes.get("tenancy", "Shared")
        capacity_status = attributes.get("capacitystatus", "Used")
        pre_installed_sw = attributes.get("preInstalledSw", "NA")
        term_type = attributes.get("termType", "OnDemand")

  #  Build EC2 pricing filters 
        ec2_filters = [
            {"Type": "TERM_MATCH", "Field": "instanceType", "Value": instance_type},
            {"Type": "TERM_MATCH", "Field": "operatingSystem", "Value": operating_system},
            {"Type": "TERM_MATCH", "Field": "tenancy", "Value": tenancy},
            {"Type": "TERM_MATCH", "Field": "capacitystatus", "Value": capacity_status},
            {"Type": "TERM_MATCH", "Field": "preInstalledSw", "Value": pre_installed_sw},
            {"Type": "TERM_MATCH", "Field": "termType", "Value": term_type},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region}
        ]

  #  Query Pricing API 
        ec2_price_response = pricing_client.get_products(
            ServiceCode='AmazonEC2',
            Filters=ec2_filters,
            MaxResults=1
        )

        if not ec2_price_response['PriceList']:
            raise ValueError("Could not fetch EC2 instance pricing info.")

        price_item = json.loads(ec2_price_response['PriceList'][0])
        term_type_key = list(price_item['terms'].keys())[0]  # 'OnDemand' or 'Reserved'
        term_data_map = price_item['terms'][term_type_key]
        first_term_id = next(iter(term_data_map))
        term_data = term_data_map[first_term_id]

        if "priceDimensions" not in term_data:
            raise ValueError("priceDimensions not found in EC2 term data.")

        price_dimension = next(iter(term_data["priceDimensions"].values()))
        instance_price_per_hour = float(price_dimension["pricePerUnit"]["USD"])
        monthly_instance_cost = round(instance_price_per_hour * 730, 4)

        
        

  # Start of EBS calculation block      
        storage_gb = attributes.get("storageGB", 30)  # default EBS size
        volume_type = attributes.get("volumeType", "gp3")  # typical default
        

  # Build EBS (EC2 storage) pricing filter
        storage_filters = [
                            {"Type": "TERM_MATCH", "Field": "serviceCode", "Value": "AmazonEC2"},
                            {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Storage"},
                            {"Type": "TERM_MATCH", "Field": "location", "Value": region},
                            {"Type": "TERM_MATCH", "Field": "volumeApiName", "Value": volume_type},
                                 
                          ]
  #  Query Pricing API 
        ebs_price_response = pricing_client.get_products(
            ServiceCode='AmazonEC2',
            Filters=storage_filters,
            MaxResults=1
        )
  # logger.debug(json.dumps(ebs_price_response, indent=2))

        if not ebs_price_response['PriceList']:
            raise ValueError("Could not fetch EC2 storage (EBS) pricing info.")

        storage_item = json.loads(ebs_price_response['PriceList'][0])
        term_type_key = list(storage_item['terms'].keys())[0]  # 'OnDemand'
        term_data_map = storage_item['terms'][term_type_key]
        first_term_id = next(iter(term_data_map))
        term_data = term_data_map[first_term_id]

        if "priceDimensions" not in term_data:
            raise ValueError("priceDimensions not found in EC2 storage term data.")

        price_dimension = next(iter(term_data["priceDimensions"].values()))
        storage_price_per_gb = float(price_dimension["pricePerUnit"]["USD"])
        monthly_storage_cost = round(storage_price_per_gb * storage_gb, 4)
        total_ec2_monthly_cost = round(monthly_instance_cost + monthly_storage_cost, 3)

        logger.info(f"monthly EC2 instance cost = {monthly_instance_cost}")
        logger.info(f"monthly EC2 EBS Storage cost = {monthly_storage_cost}")
        logger.info(f"Total Monthly EC2 Cost =  {total_ec2_monthly_cost}")
        logger.info("--------------------------------------------------------------------")
        return {
            "ec2_instance_monthly_usd": monthly_instance_cost,
            "ec2_storage_monthly_usd": monthly_storage_cost,
            "ec2_total_monthly_usd": total_ec2_monthly_cost
        }

def get_lambda_cost_estimate(pricing_client, architecture_json):
    # Find Lambda node
    lambda_node = next((node for node in architecture_json['nodes'] if node['type'] == 'AWSLambda'), None)
    if not lambda_node:
        raise ValueError("No AWSLambda node found in the architecture JSON.")

    region_friendly = lambda_node['region']
    aws_region = REGION_CODE_MAP.get(region_friendly.strip())
    aws_region_prefix = REGION_USAGE_TYPE_PREFIX.get(aws_region.strip())


    attributes = lambda_node['attributes']
    requests_per_month = attributes.get("requestsPerMonth", 1000000)
    memory_mb = attributes.get("memorySizeMB", 128)
    duration_ms = attributes.get("durationMs", 100)
    
    if not aws_region_prefix:
       raise ValueError(f"Region prefix for '{aws_region}' not found.")

    # Lambda pricing filters for compute (GB-second)
    compute_filters = [
                      {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Serverless"},
                      {"Type": "TERM_MATCH", "Field": "regionCode", "Value": aws_region},
                      {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{aws_region_prefix}-Lambda-GB-Second"},
                  ]


    compute_price_response = pricing_client.get_products(
        ServiceCode="AWSLambda",
        Filters=compute_filters,
        MaxResults=1
    )
    # logger.debug( compute_price_response)
    if not compute_price_response['PriceList']:
        raise ValueError("Could not fetch Lambda compute pricing info.")

    compute_item = json.loads(compute_price_response['PriceList'][0])
    term_type_key = list(compute_item['terms'].keys())[0]
    term_data_map = compute_item['terms'][term_type_key]
    first_term_id = next(iter(term_data_map))
    term_data = term_data_map[first_term_id]

    if "priceDimensions" not in term_data:
        raise ValueError("priceDimensions not found in Lambda compute term data.")

    compute_price_dimension = next(iter(term_data["priceDimensions"].values()))
    price_per_gb_second = float(compute_price_dimension["pricePerUnit"]["USD"])
    
    # Lambda pricing filters for requests
    request_filters = [
                      {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Serverless"},
                      {"Type": "TERM_MATCH", "Field": "regionCode", "Value": "ap-south-1"},
                      {"Type": "TERM_MATCH", "Field": "usagetype", "Value": "APS3-Request"},
                      ]
     

    request_price_response = pricing_client.get_products(
        ServiceCode="AWSLambda",
        Filters=request_filters,
        MaxResults=1
    )
#    response = pricing_client.get_products(
#    ServiceCode="AWSLambda",
#    Filters=[
#        {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
#    ],
#    MaxResults=100
#    )
#
#    for p in response['PriceList']:
#        product = json.loads(p)
#        logger.debug(json.dumps(product['product']['attributes'], indent=2))

    #logger.debug(request_price_response['PriceList'])
    if not request_price_response['PriceList']:
        raise ValueError("Could not fetch Lambda request pricing info.")

    request_item = json.loads(request_price_response['PriceList'][0])
    term_data_map = request_item['terms'][term_type_key]
    first_term_id = next(iter(term_data_map))
    request_term_data = term_data_map[first_term_id]

    if "priceDimensions" not in request_term_data:
        raise ValueError("priceDimensions not found in Lambda request term data.")

    request_price_dimension = next(iter(request_term_data["priceDimensions"].values()))
    price_per_request = float(request_price_dimension["pricePerUnit"]["USD"])

    # Compute cost calculation
    total_gb_seconds = (duration_ms / 1000) * (memory_mb / 1024) * requests_per_month
    total_compute_cost = round(price_per_gb_second * total_gb_seconds, 4)

    billable_requests = max(0, requests_per_month - 1000000)
    total_request_cost = round(price_per_request * billable_requests, 4)
    total_lambda_cost = round(total_compute_cost + total_request_cost, 4)
    logger.info(f"monthly Lambda compute cost = {total_compute_cost}")
    logger.info(f"monthly Lambda request cost = {total_request_cost}")
    logger.info(f"lambda_monthly_total_usd: {total_lambda_cost}")
    logger.info("--------------------------------------------------------------------")

    return {
        "lambda_compute_monthly_usd": total_compute_cost,
        "lambda_request_monthly_usd": total_request_cost
    }

def get_s3_cost_estimate(pricing_client, architecture_json):

    REGION_CODE_MAP = {
        "Asia Pacific (Mumbai)": "ap-south-1",
        "US East (N. Virginia)": "us-east-1",
        "Asia Pacific (Singapore)": "ap-southeast-1",
        # Add more as needed
    }
    REGION_USAGE_TYPE_PREFIX = {
                              "ap-south-1": "APS3",
                              "ap-southeast-1": "APS1",
                              "us-east-1": "USE1",
                              "us-west-2": "USW2",
                              
                            }

    #  Parse the S3 node from the architecture JSON
    s3_node = next((node for node in architecture_json['nodes'] if node['type'] == 'AmazonS3'), None)
    if not s3_node:
        raise ValueError("No AmazonS3 node found in the architecture JSON.")

    region_friendly = s3_node['region']
    aws_region = REGION_CODE_MAP.get(region_friendly)
    if not aws_region:
        raise ValueError(f"Region '{region_friendly}' not mapped to AWS region code.")

    attributes = s3_node['attributes']
    storage_gb = attributes.get('storageGB', 100)
    storage_class_input = attributes.get('storageClass', 'Standard')
    
    # Map common storage class names to AWS pricing API values
    storage_class_mapping = {
        'Standard': 'General Purpose',
        'General Purpose': 'General Purpose',
        'IA': 'Infrequent Access',
        'Infrequent Access': 'Infrequent Access',
        'Glacier': 'Archive',
        'Archive': 'Archive'
    }
    storage_class = storage_class_mapping.get(storage_class_input, 'General Purpose')
    
    num_put_requests = attributes.get('numPUTRequests', 1000)
    num_get_requests = attributes.get('numGETRequests', 10000)

    usage_prefix = REGION_USAGE_TYPE_PREFIX.get(aws_region)
    if not usage_prefix:
        raise ValueError(f"Usage prefix for region '{aws_region}' not found.")

    #  Storage Cost 
    storage_filters = [
        {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Storage"},
        {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
        {"Type": "TERM_MATCH", "Field": "storageClass", "Value": storage_class},
        {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-TimedStorage-ByteHrs"},
    ]

#    response = pricing_client.get_products(
#        ServiceCode="AmazonS3",
#        Filters=[
#            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
#        ],
#        MaxResults=100
#    )
#
#    for p in response['PriceList']:
#            product = json.loads(p)
#            logger.debug(json.dumps(product['product']['attributes'], indent=2))

#    logger.debug(request_price_response['PriceList'])

    storage_price_response = pricing_client.get_products(
        ServiceCode='AmazonS3',
        Filters=storage_filters,
        MaxResults=1
    )
    logger.debug(json.dumps(storage_price_response))
    if not storage_price_response['PriceList']:
        raise ValueError("Could not fetch S3 storage pricing info.")

    storage_item = json.loads(storage_price_response['PriceList'][0])
    term_type_key = list(storage_item['terms'].keys())[0]
    term_data_map = storage_item['terms'][term_type_key]
    first_term_id = next(iter(term_data_map))
    term_data = term_data_map[first_term_id]
    price_dimension = next(iter(term_data["priceDimensions"].values()))
    price_per_gb_month = float(price_dimension["pricePerUnit"]["USD"])
    monthly_storage_cost = round(storage_gb * price_per_gb_month, 4)

    #  PUT Request Cost 
    put_filters = [
        {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Requests"},
        {"Type": "TERM_MATCH", "Field": "operation", "Value": "PutObject"},
        {"Type": "TERM_MATCH", "Field": "regionCode", "Value": aws_region},
    ]

    put_price_response = pricing_client.get_products(
        ServiceCode='AmazonS3',
        Filters=put_filters,
        MaxResults=1
    )

    put_price = 0.0
    if put_price_response['PriceList']:
        put_item = json.loads(put_price_response['PriceList'][0])
        term_data_map = put_item['terms'][term_type_key]
        first_term_id = next(iter(term_data_map))
        term_data = term_data_map[first_term_id]
        price_dimension = next(iter(term_data["priceDimensions"].values()))
        put_price = float(price_dimension["pricePerUnit"]["USD"])
    monthly_put_cost = round(put_price * num_put_requests, 4)

    #  GET Request Cost 
    get_filters = [
        {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Requests"},
        {"Type": "TERM_MATCH", "Field": "operation", "Value": "GetObject"},
        {"Type": "TERM_MATCH", "Field": "regionCode", "Value": aws_region},
    ]

    get_price_response = pricing_client.get_products(
        ServiceCode='AmazonS3',
        Filters=get_filters,
        MaxResults=1
    )

    get_price = 0.0
    if get_price_response['PriceList']:
        get_item = json.loads(get_price_response['PriceList'][0])
        term_data_map = get_item['terms'][term_type_key]
        first_term_id = next(iter(term_data_map))
        term_data = term_data_map[first_term_id]
        price_dimension = next(iter(term_data["priceDimensions"].values()))
        get_price = float(price_dimension["pricePerUnit"]["USD"])
    monthly_get_cost = round(get_price * num_get_requests, 4)

    #  Total S3 Cost 
    total_s3_cost = round(monthly_storage_cost + monthly_put_cost + monthly_get_cost, 4)

    logger.info(f"S3_Monthly_Storage_cost = {monthly_storage_cost}")
    logger.info(f"S3_Monthly_PUT_cost = {monthly_put_cost}")
    logger.info(f"S3_Monthly_GET_cost = {monthly_get_cost}")
    logger.info(f"Total_S3_Monthly_cost = {total_s3_cost}")
    logger.info("--------------------------------------------------------------------")

    return {
        "s3_storage_monthly_usd": monthly_storage_cost,
        "s3_put_request_monthly_usd": monthly_put_cost,
        "s3_get_request_monthly_usd": monthly_get_cost,
        "s3_total_monthly_usd": total_s3_cost
    }

def get_cloudfront_cost_estimate(pricing_client, architecture_json):
    """
    Estimates the monthly cost for Amazon CloudFront based on data transfer.
    """
    
    # Find CloudFront node
    cloudfront_node = next((node for node in architecture_json['nodes'] if node['type'] == 'AmazonCloudFront'), None)
    if not cloudfront_node:
        raise ValueError("No AmazonCloudFront node found in the architecture JSON.")

    attributes = cloudfront_node['attributes']
    data_out_gb = attributes.get('dataOutGB', 100)  # Default 100GB data transfer out
    requests_per_month = attributes.get('requestsPerMonth', 1000000)  # Default 1M requests
    
    # CloudFront pricing is primarily based on US edge locations for simplicity
    # In reality, pricing varies by edge location, but US is a good baseline
    
    # Data Transfer Out pricing
    data_transfer_filters = [
        {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonCloudFront"},
        {"Type": "TERM_MATCH", "Field": "usagetype", "Value": "US-DataTransfer-Out-Bytes"},
        {"Type": "TERM_MATCH", "Field": "transferType", "Value": "CloudFront Outbound"},
    ]
    
    data_transfer_response = pricing_client.get_products(
        ServiceCode='AmazonCloudFront',
        Filters=data_transfer_filters,
        MaxResults=1
    )
    
    if not data_transfer_response['PriceList']:
        raise ValueError("Could not fetch CloudFront data transfer pricing info.")
    
    # Parse data transfer pricing
    data_transfer_item = json.loads(data_transfer_response['PriceList'][0])
    term_type_key = list(data_transfer_item['terms'].keys())[0]
    term_data_map = data_transfer_item['terms'][term_type_key]
    first_term_id = next(iter(term_data_map))
    term_data = term_data_map[first_term_id]
    price_dimension = next(iter(term_data["priceDimensions"].values()))
    data_transfer_price_per_gb = float(price_dimension["pricePerUnit"]["USD"])
    
    # Request pricing (HTTP/HTTPS requests)
    request_filters = [
        {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonCloudFront"},
        {"Type": "TERM_MATCH", "Field": "usagetype", "Value": "US-Requests-Tier1"},
        {"Type": "TERM_MATCH", "Field": "requestType", "Value": "CloudFront-Request-Tier1"},
    ]
    
    request_response = pricing_client.get_products(
        ServiceCode='AmazonCloudFront',
        Filters=request_filters,
        MaxResults=1
    )
    
    request_price_per_10k = 0.0  # Default if not found
    if request_response['PriceList']:
        request_item = json.loads(request_response['PriceList'][0])
        term_type_key = list(request_item['terms'].keys())[0]
        term_data_map = request_item['terms'][term_type_key]
        first_term_id = next(iter(term_data_map))
        term_data = term_data_map[first_term_id]
        price_dimension = next(iter(term_data["priceDimensions"].values()))
        request_price_per_10k = float(price_dimension["pricePerUnit"]["USD"])
    
    # Calculate monthly costs
    monthly_data_transfer_cost = data_out_gb * data_transfer_price_per_gb
    monthly_request_cost = (requests_per_month / 10000) * request_price_per_10k
    total_monthly_cost = monthly_data_transfer_cost + monthly_request_cost
    
    logger.info(f"CloudFront monthly data transfer cost ({data_out_gb}GB) = {monthly_data_transfer_cost:.4f}")
    logger.info(f"CloudFront monthly request cost ({requests_per_month} requests) = {monthly_request_cost:.4f}")
    logger.info(f"Total CloudFront monthly cost = {total_monthly_cost:.4f}")
    logger.info("--------------------------------------------------------------------")
    
    return {
        "cloudfront_data_transfer_monthly_usd": round(monthly_data_transfer_cost, 4),
        "cloudfront_request_monthly_usd": round(monthly_request_cost, 4),
        "cloudfront_total_monthly_usd": round(total_monthly_cost, 4)
    }

def get_apigateway_cost_estimate(pricing_client, architecture_json):
    """
    Estimates the monthly cost for Amazon API Gateway based on API calls and connection minutes.
    Supports both REST API and WebSocket API pricing.
    """
    
    # Find API Gateway node
    apigateway_node = next((node for node in architecture_json['nodes'] if node['type'] == 'AmazonApiGateway'), None)
    if not apigateway_node:
        raise ValueError("No AmazonApiGateway node found in the architecture JSON.")

    region_friendly = apigateway_node['region']
    aws_region = REGION_CODE_MAP.get(region_friendly)
    if not aws_region:
        raise ValueError(f"Region '{region_friendly}' not mapped to AWS region code.")

    attributes = apigateway_node['attributes']
    api_calls_per_month = attributes.get('apiCallsPerMonth', 1000000)  # Default 1M API calls
    websocket_minutes_per_month = attributes.get('websocketMinutesPerMonth', 0)  # Default 0 WebSocket minutes
    caching_enabled = attributes.get('cachingEnabled', False)
    cache_size_gb = attributes.get('cacheSizeGB', 0.5) if caching_enabled else 0
    
    # Get usage type prefix for the region
    usage_prefix = REGION_USAGE_TYPE_PREFIX.get(aws_region)
    if not usage_prefix:
        raise ValueError(f"Usage prefix for region '{aws_region}' not found.")
    
    total_monthly_cost = 0.0
    cost_breakdown = {}
    
    # REST API Request pricing
    if api_calls_per_month > 0:
        request_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonApiGateway"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-ApiGatewayRequest"},
        ]
        
        request_response = pricing_client.get_products(
            ServiceCode='AmazonApiGateway',
            Filters=request_filters,
            MaxResults=1
        )
        
        if not request_response['PriceList']:
            raise ValueError("Could not fetch API Gateway request pricing info.")
        
        # Parse request pricing
        request_item = json.loads(request_response['PriceList'][0])
        term_type_key = list(request_item['terms'].keys())[0]
        term_data_map = request_item['terms'][term_type_key]
        first_term_id = next(iter(term_data_map))
        term_data = term_data_map[first_term_id]
        price_dimension = next(iter(term_data["priceDimensions"].values()))
        request_price_per_call = float(price_dimension["pricePerUnit"]["USD"])
        
        monthly_request_cost = api_calls_per_month * request_price_per_call
        cost_breakdown["apigateway_request_monthly_usd"] = round(monthly_request_cost, 4)
        total_monthly_cost += monthly_request_cost
        
        logger.info(f"API Gateway monthly request cost ({api_calls_per_month} calls) = {monthly_request_cost:.4f}")
    
    # WebSocket Connection Minutes pricing
    if websocket_minutes_per_month > 0:
        websocket_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonApiGateway"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-ApiGatewayMinute"},
        ]
        
        websocket_response = pricing_client.get_products(
            ServiceCode='AmazonApiGateway',
            Filters=websocket_filters,
            MaxResults=1
        )
        
        if websocket_response['PriceList']:
            # Parse WebSocket pricing
            websocket_item = json.loads(websocket_response['PriceList'][0])
            term_type_key = list(websocket_item['terms'].keys())[0]
            term_data_map = websocket_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            websocket_price_per_minute = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_websocket_cost = websocket_minutes_per_month * websocket_price_per_minute
            cost_breakdown["apigateway_websocket_monthly_usd"] = round(monthly_websocket_cost, 4)
            total_monthly_cost += monthly_websocket_cost
            
            logger.info(f"API Gateway monthly WebSocket cost ({websocket_minutes_per_month} minutes) = {monthly_websocket_cost:.4f}")
    
    # Caching pricing (if enabled)
    if caching_enabled and cache_size_gb > 0:
        cache_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonApiGateway"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-ApiGatewayCacheUsage:{cache_size_gb}GB"},
        ]
        
        cache_response = pricing_client.get_products(
            ServiceCode='AmazonApiGateway',
            Filters=cache_filters,
            MaxResults=1
        )
        
        if cache_response['PriceList']:
            # Parse cache pricing
            cache_item = json.loads(cache_response['PriceList'][0])
            term_type_key = list(cache_item['terms'].keys())[0]
            term_data_map = cache_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            cache_price_per_hour = float(price_dimension["pricePerUnit"]["USD"])
            
            # Calculate monthly cache cost (24 hours * 30 days)
            monthly_cache_cost = cache_price_per_hour * 24 * 30
            cost_breakdown["apigateway_cache_monthly_usd"] = round(monthly_cache_cost, 4)
            total_monthly_cost += monthly_cache_cost
            
            logger.info(f"API Gateway monthly cache cost ({cache_size_gb}GB) = {monthly_cache_cost:.4f}")
    
    cost_breakdown["apigateway_total_monthly_usd"] = round(total_monthly_cost, 4)
    
    logger.info(f"Total API Gateway monthly cost = {total_monthly_cost:.4f}")
    logger.info("--------------------------------------------------------------------")
    
    return cost_breakdown

def get_natgateway_cost_estimate(pricing_client, architecture_json):
    """
    Estimates the monthly cost for Amazon VPC NAT Gateway based on hourly charges and data processing.
    """
    
    # Find NAT Gateway node
    natgateway_node = next((node for node in architecture_json['nodes'] if node['type'] == 'AmazonNATGateway'), None)
    if not natgateway_node:
        raise ValueError("No AmazonNATGateway node found in the architecture JSON.")

    region_friendly = natgateway_node['region']
    aws_region = REGION_CODE_MAP.get(region_friendly)
    if not aws_region:
        raise ValueError(f"Region '{region_friendly}' not mapped to AWS region code.")

    attributes = natgateway_node['attributes']
    data_processed_gb_per_month = attributes.get('dataProcessedGBPerMonth', 100)  # Default 100GB data processing
    hours_per_month = 24 * 30  # NAT Gateway runs 24/7
    
    # Get usage type prefix for the region
    usage_prefix = REGION_USAGE_TYPE_PREFIX.get(aws_region)
    if not usage_prefix:
        raise ValueError(f"Usage prefix for region '{aws_region}' not found.")
    
    # NAT Gateway Hourly pricing
    hourly_filters = [
        {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonEC2"},
        {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
        {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-NatGateway-Hours"},
        {"Type": "TERM_MATCH", "Field": "operation", "Value": "NatGateway"},
    ]
    
    hourly_response = pricing_client.get_products(
        ServiceCode='AmazonEC2',
        Filters=hourly_filters,
        MaxResults=1
    )
    
    if not hourly_response['PriceList']:
        raise ValueError("Could not fetch NAT Gateway hourly pricing info.")
    
    # Parse hourly pricing
    hourly_item = json.loads(hourly_response['PriceList'][0])
    term_type_key = list(hourly_item['terms'].keys())[0]
    term_data_map = hourly_item['terms'][term_type_key]
    first_term_id = next(iter(term_data_map))
    term_data = term_data_map[first_term_id]
    price_dimension = next(iter(term_data["priceDimensions"].values()))
    hourly_price = float(price_dimension["pricePerUnit"]["USD"])
    
    # NAT Gateway Data Processing pricing
    data_filters = [
        {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonEC2"},
        {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
        {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-NatGateway-Bytes"},
        {"Type": "TERM_MATCH", "Field": "operation", "Value": "NatGateway"},
    ]
    
    data_response = pricing_client.get_products(
        ServiceCode='AmazonEC2',
        Filters=data_filters,
        MaxResults=1
    )
    
    if not data_response['PriceList']:
        raise ValueError("Could not fetch NAT Gateway data processing pricing info.")
    
    # Parse data processing pricing
    data_item = json.loads(data_response['PriceList'][0])
    term_type_key = list(data_item['terms'].keys())[0]
    term_data_map = data_item['terms'][term_type_key]
    first_term_id = next(iter(term_data_map))
    term_data = term_data_map[first_term_id]
    price_dimension = next(iter(term_data["priceDimensions"].values()))
    data_processing_price_per_gb = float(price_dimension["pricePerUnit"]["USD"])
    
    # Calculate monthly costs
    monthly_hourly_cost = hours_per_month * hourly_price
    monthly_data_processing_cost = data_processed_gb_per_month * data_processing_price_per_gb
    total_monthly_cost = monthly_hourly_cost + monthly_data_processing_cost
    
    logger.info(f"NAT Gateway monthly hourly cost ({hours_per_month} hours) = {monthly_hourly_cost:.4f}")
    logger.info(f"NAT Gateway monthly data processing cost ({data_processed_gb_per_month}GB) = {monthly_data_processing_cost:.4f}")
    logger.info(f"Total NAT Gateway monthly cost = {total_monthly_cost:.4f}")
    logger.info("--------------------------------------------------------------------")
    
    return {
        "natgateway_hourly_monthly_usd": round(monthly_hourly_cost, 4),
        "natgateway_data_processing_monthly_usd": round(monthly_data_processing_cost, 4),
        "natgateway_total_monthly_usd": round(total_monthly_cost, 4)
    }

def get_route53_cost_estimate(pricing_client, architecture_json):
    """
    Estimates the monthly cost for Amazon Route 53 based on hosted zones, DNS queries, and health checks.
    """
    
    # Find Route 53 node
    route53_node = next((node for node in architecture_json['nodes'] if node['type'] == 'AmazonRoute53'), None)
    if not route53_node:
        raise ValueError("No AmazonRoute53 node found in the architecture JSON.")

    attributes = route53_node['attributes']
    hosted_zones = attributes.get('hostedZones', 1)  # Default 1 hosted zone
    dns_queries_per_month = attributes.get('dnsQueriesPerMonth', 1000000)  # Default 1M queries
    resource_record_sets = attributes.get('resourceRecordSets', 10)  # Default 10 records
    health_checks = attributes.get('healthChecks', 0)  # Default 0 health checks
    geo_queries_per_month = attributes.get('geoQueriesPerMonth', 0)  # Default 0 geo queries
    
    total_monthly_cost = 0.0
    cost_breakdown = {}
    
    # Hosted Zone pricing
    hosted_zone_filters = [
        {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonRoute53"},
        {"Type": "TERM_MATCH", "Field": "usagetype", "Value": "HostedZone"},
    ]
    
    hosted_zone_response = pricing_client.get_products(
        ServiceCode='AmazonRoute53',
        Filters=hosted_zone_filters,
        MaxResults=1
    )
    
    if not hosted_zone_response['PriceList']:
        raise ValueError("Could not fetch Route 53 hosted zone pricing info.")
    
    # Parse hosted zone pricing
    hosted_zone_item = json.loads(hosted_zone_response['PriceList'][0])
    term_type_key = list(hosted_zone_item['terms'].keys())[0]
    term_data_map = hosted_zone_item['terms'][term_type_key]
    first_term_id = next(iter(term_data_map))
    term_data = term_data_map[first_term_id]
    price_dimension = next(iter(term_data["priceDimensions"].values()))
    hosted_zone_price = float(price_dimension["pricePerUnit"]["USD"])
    
    monthly_hosted_zone_cost = hosted_zones * hosted_zone_price
    cost_breakdown["route53_hosted_zone_monthly_usd"] = round(monthly_hosted_zone_cost, 4)
    total_monthly_cost += monthly_hosted_zone_cost
    
    logger.info(f"Route 53 monthly hosted zone cost ({hosted_zones} zones) = {monthly_hosted_zone_cost:.4f}")
    
    # Resource Record Sets pricing (only for records > 25 per hosted zone)
    if resource_record_sets > 25:
        billable_records = (resource_record_sets - 25) * hosted_zones
        
        rrset_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonRoute53"},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": "Global-RRSets"},
        ]
        
        rrset_response = pricing_client.get_products(
            ServiceCode='AmazonRoute53',
            Filters=rrset_filters,
            MaxResults=1
        )
        
        if rrset_response['PriceList']:
            rrset_item = json.loads(rrset_response['PriceList'][0])
            term_type_key = list(rrset_item['terms'].keys())[0]
            term_data_map = rrset_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            rrset_price = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_rrset_cost = billable_records * rrset_price
            cost_breakdown["route53_resource_records_monthly_usd"] = round(monthly_rrset_cost, 4)
            total_monthly_cost += monthly_rrset_cost
            
            logger.info(f"Route 53 monthly resource record cost ({billable_records} billable records) = {monthly_rrset_cost:.4f}")
    
    # Standard DNS Queries pricing
    if dns_queries_per_month > 0:
        dns_query_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonRoute53"},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": "DNS-Queries"},
            {"Type": "TERM_MATCH", "Field": "routingType", "Value": "Standard"},
        ]
        
        dns_query_response = pricing_client.get_products(
            ServiceCode='AmazonRoute53',
            Filters=dns_query_filters,
            MaxResults=1
        )
        
        if dns_query_response['PriceList']:
            dns_query_item = json.loads(dns_query_response['PriceList'][0])
            term_type_key = list(dns_query_item['terms'].keys())[0]
            term_data_map = dns_query_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            dns_query_price = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_dns_query_cost = dns_queries_per_month * dns_query_price
            cost_breakdown["route53_dns_queries_monthly_usd"] = round(monthly_dns_query_cost, 4)
            total_monthly_cost += monthly_dns_query_cost
            
            logger.info(f"Route 53 monthly DNS query cost ({dns_queries_per_month} queries) = {monthly_dns_query_cost:.4f}")
    
    # Geo DNS Queries pricing (if applicable)
    if geo_queries_per_month > 0:
        geo_query_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonRoute53"},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": "Geo-Queries"},
            {"Type": "TERM_MATCH", "Field": "routingType", "Value": "Geo DNS"},
        ]
        
        geo_query_response = pricing_client.get_products(
            ServiceCode='AmazonRoute53',
            Filters=geo_query_filters,
            MaxResults=1
        )
        
        if geo_query_response['PriceList']:
            geo_query_item = json.loads(geo_query_response['PriceList'][0])
            term_type_key = list(geo_query_item['terms'].keys())[0]
            term_data_map = geo_query_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            geo_query_price = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_geo_query_cost = geo_queries_per_month * geo_query_price
            cost_breakdown["route53_geo_queries_monthly_usd"] = round(monthly_geo_query_cost, 4)
            total_monthly_cost += monthly_geo_query_cost
            
            logger.info(f"Route 53 monthly geo DNS query cost ({geo_queries_per_month} queries) = {monthly_geo_query_cost:.4f}")
    
    cost_breakdown["route53_total_monthly_usd"] = round(total_monthly_cost, 4)
    
    logger.info(f"Total Route 53 monthly cost = {total_monthly_cost:.4f}")
    logger.info("--------------------------------------------------------------------")
    
    return cost_breakdown

def get_dynamodb_cost_estimate(pricing_client, architecture_json):
    """
    Estimates the monthly cost for Amazon DynamoDB based on capacity mode (on-demand vs provisioned),
    storage, and request patterns.
    """
    
    # Find DynamoDB node
    dynamodb_node = next((node for node in architecture_json['nodes'] if node['type'] == 'AmazonDynamoDB'), None)
    if not dynamodb_node:
        raise ValueError("No AmazonDynamoDB node found in the architecture JSON.")

    region_friendly = dynamodb_node['region']
    aws_region = REGION_CODE_MAP.get(region_friendly)
    if not aws_region:
        raise ValueError(f"Region '{region_friendly}' not mapped to AWS region code.")

    attributes = dynamodb_node['attributes']
    capacity_mode = attributes.get('capacityMode', 'on-demand')  # 'on-demand' or 'provisioned'
    storage_gb = attributes.get('storageGB', 10)  # Default 10GB storage
    
    # Get usage type prefix for the region
    usage_prefix = REGION_USAGE_TYPE_PREFIX.get(aws_region)
    if not usage_prefix:
        raise ValueError(f"Usage prefix for region '{aws_region}' not found.")
    
    total_monthly_cost = 0.0
    cost_breakdown = {}
    
    # Storage pricing (same for both capacity modes)
    storage_filters = [
        {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonDynamoDB"},
        {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
        {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-TimedStorage-ByteHrs"},
    ]
    
    storage_response = pricing_client.get_products(
        ServiceCode='AmazonDynamoDB',
        Filters=storage_filters,
        MaxResults=1
    )
    
    if not storage_response['PriceList']:
        raise ValueError("Could not fetch DynamoDB storage pricing info.")
    
    # Parse storage pricing
    storage_item = json.loads(storage_response['PriceList'][0])
    term_type_key = list(storage_item['terms'].keys())[0]
    term_data_map = storage_item['terms'][term_type_key]
    first_term_id = next(iter(term_data_map))
    term_data = term_data_map[first_term_id]
    price_dimension = next(iter(term_data["priceDimensions"].values()))
    storage_price_per_gb_month = float(price_dimension["pricePerUnit"]["USD"])
    
    monthly_storage_cost = storage_gb * storage_price_per_gb_month
    cost_breakdown["dynamodb_storage_monthly_usd"] = round(monthly_storage_cost, 4)
    total_monthly_cost += monthly_storage_cost
    
    logger.info(f"DynamoDB monthly storage cost ({storage_gb}GB) = {monthly_storage_cost:.4f}")
    
    if capacity_mode.lower() == 'on-demand':
        # On-demand pricing
        read_request_units_per_month = attributes.get('readRequestUnitsPerMonth', 1000000)  # Default 1M RRUs
        write_request_units_per_month = attributes.get('writeRequestUnitsPerMonth', 500000)  # Default 500K WRUs
        
        # Read Request Units pricing
        read_request_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonDynamoDB"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-ReadRequestUnits"},
            {"Type": "TERM_MATCH", "Field": "operation", "Value": "PayPerRequestThroughput"},
        ]
        
        read_request_response = pricing_client.get_products(
            ServiceCode='AmazonDynamoDB',
            Filters=read_request_filters,
            MaxResults=1
        )
        
        if read_request_response['PriceList']:
            read_request_item = json.loads(read_request_response['PriceList'][0])
            term_type_key = list(read_request_item['terms'].keys())[0]
            term_data_map = read_request_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            read_request_price = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_read_request_cost = read_request_units_per_month * read_request_price
            cost_breakdown["dynamodb_read_requests_monthly_usd"] = round(monthly_read_request_cost, 4)
            total_monthly_cost += monthly_read_request_cost
            
            logger.info(f"DynamoDB monthly read request cost ({read_request_units_per_month} RRUs) = {monthly_read_request_cost:.4f}")
        
        # Write Request Units pricing
        write_request_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonDynamoDB"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-WriteRequestUnits"},
            {"Type": "TERM_MATCH", "Field": "operation", "Value": "PayPerRequestThroughput"},
        ]
        
        write_request_response = pricing_client.get_products(
            ServiceCode='AmazonDynamoDB',
            Filters=write_request_filters,
            MaxResults=1
        )
        
        if write_request_response['PriceList']:
            write_request_item = json.loads(write_request_response['PriceList'][0])
            term_type_key = list(write_request_item['terms'].keys())[0]
            term_data_map = write_request_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            write_request_price = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_write_request_cost = write_request_units_per_month * write_request_price
            cost_breakdown["dynamodb_write_requests_monthly_usd"] = round(monthly_write_request_cost, 4)
            total_monthly_cost += monthly_write_request_cost
            
            logger.info(f"DynamoDB monthly write request cost ({write_request_units_per_month} WRUs) = {monthly_write_request_cost:.4f}")
    
    else:
        # Provisioned capacity pricing
        read_capacity_units = attributes.get('readCapacityUnits', 5)  # Default 5 RCUs
        write_capacity_units = attributes.get('writeCapacityUnits', 5)  # Default 5 WCUs
        hours_per_month = 24 * 30  # 720 hours per month
        
        # Read Capacity Units pricing
        read_capacity_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonDynamoDB"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-ReadCapacityUnit-Hrs"},
            {"Type": "TERM_MATCH", "Field": "operation", "Value": "CommittedThroughput"},
        ]
        
        read_capacity_response = pricing_client.get_products(
            ServiceCode='AmazonDynamoDB',
            Filters=read_capacity_filters,
            MaxResults=1
        )
        
        if read_capacity_response['PriceList']:
            read_capacity_item = json.loads(read_capacity_response['PriceList'][0])
            term_type_key = list(read_capacity_item['terms'].keys())[0]
            term_data_map = read_capacity_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            read_capacity_price = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_read_capacity_cost = read_capacity_units * hours_per_month * read_capacity_price
            cost_breakdown["dynamodb_read_capacity_monthly_usd"] = round(monthly_read_capacity_cost, 4)
            total_monthly_cost += monthly_read_capacity_cost
            
            logger.info(f"DynamoDB monthly read capacity cost ({read_capacity_units} RCUs) = {monthly_read_capacity_cost:.4f}")
        
        # Write Capacity Units pricing
        write_capacity_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonDynamoDB"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-WriteCapacityUnit-Hrs"},
            {"Type": "TERM_MATCH", "Field": "operation", "Value": "CommittedThroughput"},
        ]
        
        write_capacity_response = pricing_client.get_products(
            ServiceCode='AmazonDynamoDB',
            Filters=write_capacity_filters,
            MaxResults=1
        )
        
        if write_capacity_response['PriceList']:
            write_capacity_item = json.loads(write_capacity_response['PriceList'][0])
            term_type_key = list(write_capacity_item['terms'].keys())[0]
            term_data_map = write_capacity_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            write_capacity_price = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_write_capacity_cost = write_capacity_units * hours_per_month * write_capacity_price
            cost_breakdown["dynamodb_write_capacity_monthly_usd"] = round(monthly_write_capacity_cost, 4)
            total_monthly_cost += monthly_write_capacity_cost
            
            logger.info(f"DynamoDB monthly write capacity cost ({write_capacity_units} WCUs) = {monthly_write_capacity_cost:.4f}")
    
    cost_breakdown["dynamodb_total_monthly_usd"] = round(total_monthly_cost, 4)
    
    logger.info(f"Total DynamoDB monthly cost ({capacity_mode} mode) = {total_monthly_cost:.4f}")
    logger.info("--------------------------------------------------------------------")
    
    return cost_breakdown

def get_sqs_cost_estimate(pricing_client, architecture_json):
    """
    Estimates the monthly cost for Amazon SQS based on queue type and request volume.
    Includes free tier calculation (first 1M requests per month are free).
    """
    
    # Find SQS node
    sqs_node = next((node for node in architecture_json['nodes'] if node['type'] == 'AmazonSQS'), None)
    if not sqs_node:
        raise ValueError("No AmazonSQS node found in the architecture JSON.")

    region_friendly = sqs_node['region']
    aws_region = REGION_CODE_MAP.get(region_friendly)
    if not aws_region:
        raise ValueError(f"Region '{region_friendly}' not mapped to AWS region code.")

    attributes = sqs_node['attributes']
    queue_type = attributes.get('queueType', 'Standard')  # 'Standard' or 'FIFO'
    requests_per_month = attributes.get('requestsPerMonth', 2000000)  # Default 2M requests
    
    # Get usage type prefix for the region
    usage_prefix = REGION_USAGE_TYPE_PREFIX.get(aws_region)
    if not usage_prefix:
        raise ValueError(f"Usage prefix for region '{aws_region}' not found.")
    
    # SQS has a free tier of 1M requests per month
    free_tier_requests = 1000000
    billable_requests = max(0, requests_per_month - free_tier_requests)
    
    # Determine usage type based on queue type
    if queue_type.upper() == 'FIFO':
        usage_type = f"{usage_prefix}-Requests-Fair-Tier1"
        queue_type_for_filter = "Fair"
    else:
        usage_type = f"{usage_prefix}-Requests-Tier1"
        queue_type_for_filter = "Standard"
    
    # SQS Request pricing
    request_filters = [
        {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AWSQueueService"},
        {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
        {"Type": "TERM_MATCH", "Field": "usagetype", "Value": usage_type},
    ]
    
    request_response = pricing_client.get_products(
        ServiceCode='AWSQueueService',
        Filters=request_filters,
        MaxResults=1
    )
    
    if not request_response['PriceList']:
        raise ValueError(f"Could not fetch SQS {queue_type} queue pricing info.")
    
    # Parse request pricing
    request_item = json.loads(request_response['PriceList'][0])
    term_type_key = list(request_item['terms'].keys())[0]
    term_data_map = request_item['terms'][term_type_key]
    first_term_id = next(iter(term_data_map))
    term_data = term_data_map[first_term_id]
    price_dimension = next(iter(term_data["priceDimensions"].values()))
    request_price = float(price_dimension["pricePerUnit"]["USD"])
    
    # Calculate monthly costs
    monthly_request_cost = billable_requests * request_price
    free_tier_savings = free_tier_requests * request_price if requests_per_month > free_tier_requests else requests_per_month * request_price
    
    cost_breakdown = {
        "sqs_requests_monthly_usd": round(monthly_request_cost, 4),
        "sqs_free_tier_savings_usd": round(free_tier_savings, 4),
        "sqs_total_monthly_usd": round(monthly_request_cost, 4)
    }
    
    logger.info(f"SQS monthly request cost ({requests_per_month} total, {billable_requests} billable) = {monthly_request_cost:.4f}")
    logger.info(f"SQS free tier savings (first {min(requests_per_month, free_tier_requests)} requests) = {free_tier_savings:.4f}")
    logger.info(f"Total SQS monthly cost ({queue_type} queue) = {monthly_request_cost:.4f}")
    logger.info("--------------------------------------------------------------------")
    
    return cost_breakdown

def get_elasticache_cost_estimate(pricing_client, architecture_json):
    """
    Estimates the monthly cost for Amazon ElastiCache based on instance type, cache engine,
    and backup storage.
    """
    
    # Find ElastiCache node
    elasticache_node = next((node for node in architecture_json['nodes'] if node['type'] == 'AmazonElastiCache'), None)
    if not elasticache_node:
        raise ValueError("No AmazonElastiCache node found in the architecture JSON.")

    region_friendly = elasticache_node['region']
    aws_region = REGION_CODE_MAP.get(region_friendly)
    if not aws_region:
        raise ValueError(f"Region '{region_friendly}' not mapped to AWS region code.")

    attributes = elasticache_node['attributes']
    instance_type = attributes.get('instanceType', 'cache.t3.micro')  # Default cache.t3.micro
    cache_engine = attributes.get('cacheEngine', 'Redis')  # 'Redis' or 'Memcached'
    backup_storage_gb = attributes.get('backupStorageGB', 0)  # Default 0GB backup storage
    
    # Get usage type prefix for the region
    usage_prefix = REGION_USAGE_TYPE_PREFIX.get(aws_region)
    if not usage_prefix:
        raise ValueError(f"Usage prefix for region '{aws_region}' not found.")
    
    total_monthly_cost = 0.0
    cost_breakdown = {}
    hours_per_month = 24 * 30  # 720 hours per month
    
    # ElastiCache Node pricing
    node_filters = [
        {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonElastiCache"},
        {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
        {"Type": "TERM_MATCH", "Field": "instanceType", "Value": instance_type},
        {"Type": "TERM_MATCH", "Field": "cacheEngine", "Value": cache_engine},
    ]
    
    node_response = pricing_client.get_products(
        ServiceCode='AmazonElastiCache',
        Filters=node_filters,
        MaxResults=1
    )
    
    if not node_response['PriceList']:
        raise ValueError(f"Could not fetch ElastiCache {cache_engine} {instance_type} pricing info.")
    
    # Parse node pricing
    node_item = json.loads(node_response['PriceList'][0])
    term_type_key = list(node_item['terms'].keys())[0]
    term_data_map = node_item['terms'][term_type_key]
    first_term_id = next(iter(term_data_map))
    term_data = term_data_map[first_term_id]
    price_dimension = next(iter(term_data["priceDimensions"].values()))
    hourly_price = float(price_dimension["pricePerUnit"]["USD"])
    
    monthly_node_cost = hours_per_month * hourly_price
    cost_breakdown["elasticache_node_monthly_usd"] = round(monthly_node_cost, 4)
    total_monthly_cost += monthly_node_cost
    
    logger.info(f"ElastiCache monthly node cost ({instance_type} {cache_engine}) = {monthly_node_cost:.4f}")
    
    # Backup Storage pricing (only for Redis)
    if cache_engine.lower() == 'redis' and backup_storage_gb > 0:
        backup_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonElastiCache"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-BackupUsage:Redis"},
            {"Type": "TERM_MATCH", "Field": "cacheEngine", "Value": "Redis"},
        ]
        
        backup_response = pricing_client.get_products(
            ServiceCode='AmazonElastiCache',
            Filters=backup_filters,
            MaxResults=1
        )
        
        if backup_response['PriceList']:
            backup_item = json.loads(backup_response['PriceList'][0])
            term_type_key = list(backup_item['terms'].keys())[0]
            term_data_map = backup_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            backup_price_per_gb_month = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_backup_cost = backup_storage_gb * backup_price_per_gb_month
            cost_breakdown["elasticache_backup_monthly_usd"] = round(monthly_backup_cost, 4)
            total_monthly_cost += monthly_backup_cost
            
            logger.info(f"ElastiCache monthly backup cost ({backup_storage_gb}GB) = {monthly_backup_cost:.4f}")
    
    cost_breakdown["elasticache_total_monthly_usd"] = round(total_monthly_cost, 4)
    
    logger.info(f"Total ElastiCache monthly cost ({cache_engine} {instance_type}) = {total_monthly_cost:.4f}")
    logger.info("--------------------------------------------------------------------")
    
    return cost_breakdown

def get_alb_cost_estimate(pricing_client, architecture_json):
    """
    Estimates the monthly cost for Application Load Balancer (ALB) based on hourly charges
    and Load Balancer Capacity Units (LCUs).
    """
    
    # Find ALB node
    alb_node = next((node for node in architecture_json['nodes'] if node['type'] == 'ApplicationLoadBalancer'), None)
    if not alb_node:
        raise ValueError("No ApplicationLoadBalancer node found in the architecture JSON.")

    region_friendly = alb_node['region']
    aws_region = REGION_CODE_MAP.get(region_friendly)
    if not aws_region:
        raise ValueError(f"Region '{region_friendly}' not mapped to AWS region code.")

    attributes = alb_node['attributes']
    # LCU estimation based on traffic patterns
    new_connections_per_second = attributes.get('newConnectionsPerSecond', 25)  # Default 25/sec
    active_connections_per_minute = attributes.get('activeConnectionsPerMinute', 3000)  # Default 3000/min
    bandwidth_mbps = attributes.get('bandwidthMbps', 1)  # Default 1 Mbps
    rule_evaluations_per_second = attributes.get('ruleEvaluationsPerSecond', 1000)  # Default 1000/sec
    
    # Get usage type prefix for the region
    usage_prefix = REGION_USAGE_TYPE_PREFIX.get(aws_region)
    if not usage_prefix:
        raise ValueError(f"Usage prefix for region '{aws_region}' not found.")
    
    hours_per_month = 24 * 30  # 720 hours per month
    
    # ALB Hourly pricing
    hourly_filters = [
        {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AWSELB"},
        {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
        {"Type": "TERM_MATCH", "Field": "operation", "Value": "LoadBalancing:Application"},
        {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-LoadBalancerUsage"},
    ]
    
    hourly_response = pricing_client.get_products(
        ServiceCode='AWSELB',
        Filters=hourly_filters,
        MaxResults=1
    )
    
    if not hourly_response['PriceList']:
        raise ValueError("Could not fetch ALB hourly pricing info.")
    
    # Parse hourly pricing
    hourly_item = json.loads(hourly_response['PriceList'][0])
    term_type_key = list(hourly_item['terms'].keys())[0]
    term_data_map = hourly_item['terms'][term_type_key]
    first_term_id = next(iter(term_data_map))
    term_data = term_data_map[first_term_id]
    price_dimension = next(iter(term_data["priceDimensions"].values()))
    hourly_price = float(price_dimension["pricePerUnit"]["USD"])
    
    # ALB LCU pricing
    lcu_filters = [
        {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AWSELB"},
        {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
        {"Type": "TERM_MATCH", "Field": "operation", "Value": "LoadBalancing:Application"},
        {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-LCUUsage"},
    ]
    
    lcu_response = pricing_client.get_products(
        ServiceCode='AWSELB',
        Filters=lcu_filters,
        MaxResults=1
    )
    
    if not lcu_response['PriceList']:
        raise ValueError("Could not fetch ALB LCU pricing info.")
    
    # Parse LCU pricing
    lcu_item = json.loads(lcu_response['PriceList'][0])
    term_type_key = list(lcu_item['terms'].keys())[0]
    term_data_map = lcu_item['terms'][term_type_key]
    first_term_id = next(iter(term_data_map))
    term_data = term_data_map[first_term_id]
    price_dimension = next(iter(term_data["priceDimensions"].values()))
    lcu_price_per_hour = float(price_dimension["pricePerUnit"]["USD"])
    
    # Calculate LCU consumption
    # LCU is the maximum of these four dimensions:
    # 1. New connections: 25 per second
    # 2. Active connections: 3,000 per minute
    # 3. Bandwidth: 1 GB per hour (processed bytes)
    # 4. Rule evaluations: 1,000 per second
    
    new_connections_lcu = new_connections_per_second / 25
    active_connections_lcu = active_connections_per_minute / 3000
    bandwidth_lcu = bandwidth_mbps * 0.125 / 1  # Convert Mbps to GB/hour (Mbps * 0.125 * 3600 / 3600)
    rule_evaluations_lcu = rule_evaluations_per_second / 1000
    
    # LCU is the maximum of the four dimensions
    lcu_per_hour = max(new_connections_lcu, active_connections_lcu, bandwidth_lcu, rule_evaluations_lcu)
    
    # Ensure minimum of 1 LCU (AWS charges minimum 1 LCU per hour)
    lcu_per_hour = max(1, lcu_per_hour)
    
    # Calculate monthly costs
    monthly_hourly_cost = hours_per_month * hourly_price
    monthly_lcu_cost = hours_per_month * lcu_per_hour * lcu_price_per_hour
    total_monthly_cost = monthly_hourly_cost + monthly_lcu_cost
    
    cost_breakdown = {
        "alb_hourly_monthly_usd": round(monthly_hourly_cost, 4),
        "alb_lcu_monthly_usd": round(monthly_lcu_cost, 4),
        "alb_total_monthly_usd": round(total_monthly_cost, 4)
    }
    
    logger.info(f"ALB monthly hourly cost (720 hours) = {monthly_hourly_cost:.4f}")
    logger.info(f"ALB monthly LCU cost ({lcu_per_hour:.2f} LCU/hour) = {monthly_lcu_cost:.4f}")
    logger.info(f"Total ALB monthly cost = {total_monthly_cost:.4f}")
    logger.info("--------------------------------------------------------------------")
    
    return cost_breakdown

def get_ecs_cost_estimate(pricing_client, architecture_json):
    """
    Estimates the monthly cost for Amazon ECS based on launch type (Fargate or EC2),
    vCPU, memory, and task configuration.
    """
    
    # Find ECS node
    ecs_node = next((node for node in architecture_json['nodes'] if node['type'] == 'AmazonECS'), None)
    if not ecs_node:
        raise ValueError("No AmazonECS node found in the architecture JSON.")

    region_friendly = ecs_node['region']
    aws_region = REGION_CODE_MAP.get(region_friendly)
    if not aws_region:
        raise ValueError(f"Region '{region_friendly}' not mapped to AWS region code.")

    attributes = ecs_node['attributes']
    launch_type = attributes.get('launchType', 'FARGATE')  # 'FARGATE' or 'EC2'
    vcpu = attributes.get('vCPU', 0.25)  # Default 0.25 vCPU
    memory_gb = attributes.get('memoryGB', 0.5)  # Default 0.5 GB memory
    tasks_count = attributes.get('tasksCount', 1)  # Default 1 task
    hours_per_month = attributes.get('hoursPerMonth', 24 * 30)  # Default 720 hours (always running)
    
    # Get usage type prefix for the region
    usage_prefix = REGION_USAGE_TYPE_PREFIX.get(aws_region)
    if not usage_prefix:
        raise ValueError(f"Usage prefix for region '{aws_region}' not found.")
    
    total_monthly_cost = 0.0
    cost_breakdown = {}
    
    if launch_type.upper() == 'FARGATE':
        # Fargate vCPU pricing
        vcpu_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonECS"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-Fargate-vCPU-Hours:perCPU"},
        ]
        
        vcpu_response = pricing_client.get_products(
            ServiceCode='AmazonECS',
            Filters=vcpu_filters,
            MaxResults=1
        )
        
        if not vcpu_response['PriceList']:
            raise ValueError("Could not fetch ECS Fargate vCPU pricing info.")
        
        # Parse vCPU pricing
        vcpu_item = json.loads(vcpu_response['PriceList'][0])
        term_type_key = list(vcpu_item['terms'].keys())[0]
        term_data_map = vcpu_item['terms'][term_type_key]
        first_term_id = next(iter(term_data_map))
        term_data = term_data_map[first_term_id]
        price_dimension = next(iter(term_data["priceDimensions"].values()))
        vcpu_price_per_hour = float(price_dimension["pricePerUnit"]["USD"])
        
        # Fargate Memory pricing
        memory_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonECS"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-Fargate-GB-Hours"},
        ]
        
        memory_response = pricing_client.get_products(
            ServiceCode='AmazonECS',
            Filters=memory_filters,
            MaxResults=1
        )
        
        if not memory_response['PriceList']:
            raise ValueError("Could not fetch ECS Fargate memory pricing info.")
        
        # Parse memory pricing
        memory_item = json.loads(memory_response['PriceList'][0])
        term_type_key = list(memory_item['terms'].keys())[0]
        term_data_map = memory_item['terms'][term_type_key]
        first_term_id = next(iter(term_data_map))
        term_data = term_data_map[first_term_id]
        price_dimension = next(iter(term_data["priceDimensions"].values()))
        memory_price_per_gb_hour = float(price_dimension["pricePerUnit"]["USD"])
        
        # Calculate monthly costs
        monthly_vcpu_cost = vcpu * tasks_count * hours_per_month * vcpu_price_per_hour
        monthly_memory_cost = memory_gb * tasks_count * hours_per_month * memory_price_per_gb_hour
        total_monthly_cost = monthly_vcpu_cost + monthly_memory_cost
        
        cost_breakdown = {
            "ecs_fargate_vcpu_monthly_usd": round(monthly_vcpu_cost, 4),
            "ecs_fargate_memory_monthly_usd": round(monthly_memory_cost, 4),
            "ecs_fargate_total_monthly_usd": round(total_monthly_cost, 4)
        }
        
        logger.info(f"ECS Fargate monthly vCPU cost ({vcpu} vCPU × {tasks_count} tasks) = {monthly_vcpu_cost:.4f}")
        logger.info(f"ECS Fargate monthly memory cost ({memory_gb}GB × {tasks_count} tasks) = {monthly_memory_cost:.4f}")
        logger.info(f"Total ECS Fargate monthly cost = {total_monthly_cost:.4f}")
        
    else:
        # ECS on EC2 - no additional charges beyond EC2 instances
        # Note: This assumes EC2 instances are already accounted for separately
        cost_breakdown = {
            "ecs_ec2_monthly_usd": 0.0,
            "ecs_ec2_total_monthly_usd": 0.0
        }
        
        logger.info(f"ECS on EC2 monthly cost = $0.00 (EC2 instances charged separately)")
        logger.info("Note: ECS on EC2 has no additional charges beyond EC2 instance costs")
    
    logger.info("--------------------------------------------------------------------")
    
    return cost_breakdown

def get_sns_cost_estimate(pricing_client, architecture_json):
    """
    Estimates the monthly cost for Amazon SNS based on API requests and delivery attempts
    across different endpoint types (HTTP, SMS, Mobile Push, Email).
    """
    
    # Find SNS node
    sns_node = next((node for node in architecture_json['nodes'] if node['type'] == 'AmazonSNS'), None)
    if not sns_node:
        raise ValueError("No AmazonSNS node found in the architecture JSON.")

    region_friendly = sns_node['region']
    aws_region = REGION_CODE_MAP.get(region_friendly)
    if not aws_region:
        raise ValueError(f"Region '{region_friendly}' not mapped to AWS region code.")

    attributes = sns_node['attributes']
    api_requests_per_month = attributes.get('apiRequestsPerMonth', 1000000)  # Default 1M requests
    http_notifications_per_month = attributes.get('httpNotificationsPerMonth', 500000)  # Default 500K HTTP
    sms_notifications_per_month = attributes.get('smsNotificationsPerMonth', 0)  # Default 0 SMS
    mobile_push_notifications_per_month = attributes.get('mobilePushNotificationsPerMonth', 0)  # Default 0 mobile push
    email_notifications_per_month = attributes.get('emailNotificationsPerMonth', 0)  # Default 0 email
    
    # Get usage type prefix for the region
    usage_prefix = REGION_USAGE_TYPE_PREFIX.get(aws_region)
    if not usage_prefix:
        raise ValueError(f"Usage prefix for region '{aws_region}' not found.")
    
    total_monthly_cost = 0.0
    cost_breakdown = {}
    
    # SNS has a free tier of 1M API requests per month
    free_tier_requests = 1000000
    billable_requests = max(0, api_requests_per_month - free_tier_requests)
    
    # API Requests pricing (after free tier)
    if billable_requests > 0:
        request_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonSNS"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-Requests-Tier1"},
        ]
        
        request_response = pricing_client.get_products(
            ServiceCode='AmazonSNS',
            Filters=request_filters,
            MaxResults=1
        )
        
        if request_response['PriceList']:
            request_item = json.loads(request_response['PriceList'][0])
            term_type_key = list(request_item['terms'].keys())[0]
            term_data_map = request_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            request_price = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_request_cost = billable_requests * request_price
            cost_breakdown["sns_api_requests_monthly_usd"] = round(monthly_request_cost, 4)
            total_monthly_cost += monthly_request_cost
            
            logger.info(f"SNS monthly API request cost ({billable_requests} billable requests) = {monthly_request_cost:.4f}")
    
    # HTTP/HTTPS Notifications pricing
    if http_notifications_per_month > 0:
        http_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonSNS"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-DeliveryAttempts-HTTP"},
        ]
        
        http_response = pricing_client.get_products(
            ServiceCode='AmazonSNS',
            Filters=http_filters,
            MaxResults=1
        )
        
        if http_response['PriceList']:
            http_item = json.loads(http_response['PriceList'][0])
            term_type_key = list(http_item['terms'].keys())[0]
            term_data_map = http_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            http_price = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_http_cost = http_notifications_per_month * http_price
            cost_breakdown["sns_http_notifications_monthly_usd"] = round(monthly_http_cost, 4)
            total_monthly_cost += monthly_http_cost
            
            logger.info(f"SNS monthly HTTP notification cost ({http_notifications_per_month} notifications) = {monthly_http_cost:.4f}")
    
    # SMS Notifications pricing (if applicable)
    if sms_notifications_per_month > 0:
        sms_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonSNS"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-DeliveryAttempts-SMS"},
        ]
        
        sms_response = pricing_client.get_products(
            ServiceCode='AmazonSNS',
            Filters=sms_filters,
            MaxResults=1
        )
        
        if sms_response['PriceList']:
            sms_item = json.loads(sms_response['PriceList'][0])
            term_type_key = list(sms_item['terms'].keys())[0]
            term_data_map = sms_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            sms_price = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_sms_cost = sms_notifications_per_month * sms_price
            cost_breakdown["sns_sms_notifications_monthly_usd"] = round(monthly_sms_cost, 4)
            total_monthly_cost += monthly_sms_cost
            
            logger.info(f"SNS monthly SMS notification cost ({sms_notifications_per_month} notifications) = {monthly_sms_cost:.4f}")
    
    # Mobile Push Notifications pricing (if applicable)
    if mobile_push_notifications_per_month > 0:
        # Use APNS as a representative mobile push service
        mobile_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonSNS"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-DeliveryAttempts-APNS_SB"},
        ]
        
        mobile_response = pricing_client.get_products(
            ServiceCode='AmazonSNS',
            Filters=mobile_filters,
            MaxResults=1
        )
        
        if mobile_response['PriceList']:
            mobile_item = json.loads(mobile_response['PriceList'][0])
            term_type_key = list(mobile_item['terms'].keys())[0]
            term_data_map = mobile_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            mobile_price = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_mobile_cost = mobile_push_notifications_per_month * mobile_price
            cost_breakdown["sns_mobile_push_notifications_monthly_usd"] = round(monthly_mobile_cost, 4)
            total_monthly_cost += monthly_mobile_cost
            
            logger.info(f"SNS monthly mobile push notification cost ({mobile_push_notifications_per_month} notifications) = {monthly_mobile_cost:.4f}")
    
    # Free tier savings calculation
    free_tier_savings = min(api_requests_per_month, free_tier_requests) * 0.0000005  # Estimated value
    cost_breakdown["sns_free_tier_savings_usd"] = round(free_tier_savings, 4)
    cost_breakdown["sns_total_monthly_usd"] = round(total_monthly_cost, 4)
    
    logger.info(f"SNS free tier savings (first {min(api_requests_per_month, free_tier_requests)} requests) = {free_tier_savings:.4f}")
    logger.info(f"Total SNS monthly cost = {total_monthly_cost:.4f}")
    logger.info("--------------------------------------------------------------------")
    
    return cost_breakdown

    """
    Estimates the monthly cost for Amazon CloudWatch based on custom metrics, logs ingestion,
    alarms, dashboards, and API requests.
    """
    
    # Find CloudWatch node
    cloudwatch_node = next((node for node in architecture_json['nodes'] if node['type'] == 'AmazonCloudWatch'), None)
    if not cloudwatch_node:
        raise ValueError("No AmazonCloudWatch node found in the architecture JSON.")

    region_friendly = cloudwatch_node['region']
    aws_region = REGION_CODE_MAP.get(region_friendly)
    if not aws_region:
        raise ValueError(f"Region '{region_friendly}' not mapped to AWS region code.")

    attributes = cloudwatch_node['attributes']
    custom_metrics = attributes.get('customMetrics', 10)  # Default 10 custom metrics
    logs_ingestion_gb_per_month = attributes.get('logsIngestionGBPerMonth', 5)  # Default 5GB logs
    standard_alarms = attributes.get('standardAlarms', 5)  # Default 5 standard alarms
    high_resolution_alarms = attributes.get('highResolutionAlarms', 0)  # Default 0 high-res alarms
    dashboards = attributes.get('dashboards', 1)  # Default 1 dashboard
    api_requests_per_month = attributes.get('apiRequestsPerMonth', 100000)  # Default 100K API requests
    
    # Get usage type prefix for the region
    usage_prefix = REGION_USAGE_TYPE_PREFIX.get(aws_region)
    if not usage_prefix:
        raise ValueError(f"Usage prefix for region '{aws_region}' not found.")
    
    total_monthly_cost = 0.0
    cost_breakdown = {}
    
    # Custom Metrics pricing
    if custom_metrics > 0:
        metrics_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonCloudWatch"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-CW:MetricMonitorUsage"},
        ]
        
        metrics_response = pricing_client.get_products(
            ServiceCode='AmazonCloudWatch',
            Filters=metrics_filters,
            MaxResults=1
        )
        
        if metrics_response['PriceList']:
            metrics_item = json.loads(metrics_response['PriceList'][0])
            term_type_key = list(metrics_item['terms'].keys())[0]
            term_data_map = metrics_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            metrics_price = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_metrics_cost = custom_metrics * metrics_price
            cost_breakdown["cloudwatch_custom_metrics_monthly_usd"] = round(monthly_metrics_cost, 4)
            total_monthly_cost += monthly_metrics_cost
            
            logger.info(f"CloudWatch monthly custom metrics cost ({custom_metrics} metrics) = {monthly_metrics_cost:.4f}")
    
    # Logs Ingestion pricing
    if logs_ingestion_gb_per_month > 0:
        logs_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonCloudWatch"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-DataProcessing-Bytes"},
        ]
        
        logs_response = pricing_client.get_products(
            ServiceCode='AmazonCloudWatch',
            Filters=logs_filters,
            MaxResults=1
        )
        
        if logs_response['PriceList']:
            logs_item = json.loads(logs_response['PriceList'][0])
            term_type_key = list(logs_item['terms'].keys())[0]
            term_data_map = logs_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            logs_price_per_gb = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_logs_cost = logs_ingestion_gb_per_month * logs_price_per_gb
            cost_breakdown["cloudwatch_logs_ingestion_monthly_usd"] = round(monthly_logs_cost, 4)
            total_monthly_cost += monthly_logs_cost
            
            logger.info(f"CloudWatch monthly logs ingestion cost ({logs_ingestion_gb_per_month}GB) = {monthly_logs_cost:.4f}")
    
    # Standard Alarms pricing
    if standard_alarms > 0:
        alarms_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonCloudWatch"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-CW:AlarmMonitorUsage"},
        ]
        
        alarms_response = pricing_client.get_products(
            ServiceCode='AmazonCloudWatch',
            Filters=alarms_filters,
            MaxResults=1
        )
        
        if alarms_response['PriceList']:
            alarms_item = json.loads(alarms_response['PriceList'][0])
            term_type_key = list(alarms_item['terms'].keys())[0]
            term_data_map = alarms_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            alarms_price = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_alarms_cost = standard_alarms * alarms_price
            cost_breakdown["cloudwatch_standard_alarms_monthly_usd"] = round(monthly_alarms_cost, 4)
            total_monthly_cost += monthly_alarms_cost
            
            logger.info(f"CloudWatch monthly standard alarms cost ({standard_alarms} alarms) = {monthly_alarms_cost:.4f}")
    
    # High-Resolution Alarms pricing
    if high_resolution_alarms > 0:
        high_res_alarms_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonCloudWatch"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-CW:HighResAlarmMonitorUsage"},
        ]
        
        high_res_alarms_response = pricing_client.get_products(
            ServiceCode='AmazonCloudWatch',
            Filters=high_res_alarms_filters,
            MaxResults=1
        )
        
        if high_res_alarms_response['PriceList']:
            high_res_alarms_item = json.loads(high_res_alarms_response['PriceList'][0])
            term_type_key = list(high_res_alarms_item['terms'].keys())[0]
            term_data_map = high_res_alarms_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            high_res_alarms_price = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_high_res_alarms_cost = high_resolution_alarms * high_res_alarms_price
            cost_breakdown["cloudwatch_high_res_alarms_monthly_usd"] = round(monthly_high_res_alarms_cost, 4)
            total_monthly_cost += monthly_high_res_alarms_cost
            
            logger.info(f"CloudWatch monthly high-res alarms cost ({high_resolution_alarms} alarms) = {monthly_high_res_alarms_cost:.4f}")
    
    # API Requests pricing
    if api_requests_per_month > 0:
        api_filters = [
            {"Type": "TERM_MATCH", "Field": "servicecode", "Value": "AmazonCloudWatch"},
            {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
            {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-CW:Requests"},
        ]
        
        api_response = pricing_client.get_products(
            ServiceCode='AmazonCloudWatch',
            Filters=api_filters,
            MaxResults=1
        )
        
        if api_response['PriceList']:
            api_item = json.loads(api_response['PriceList'][0])
            term_type_key = list(api_item['terms'].keys())[0]
            term_data_map = api_item['terms'][term_type_key]
            first_term_id = next(iter(term_data_map))
            term_data = term_data_map[first_term_id]
            price_dimension = next(iter(term_data["priceDimensions"].values()))
            api_price = float(price_dimension["pricePerUnit"]["USD"])
            
            monthly_api_cost = api_requests_per_month * api_price
            cost_breakdown["cloudwatch_api_requests_monthly_usd"] = round(monthly_api_cost, 4)
            total_monthly_cost += monthly_api_cost
            
            logger.info(f"CloudWatch monthly API requests cost ({api_requests_per_month} requests) = {monthly_api_cost:.4f}")
    
    # Dashboards pricing (estimated at $3 per dashboard per month)
    if dashboards > 0:
        dashboard_price = 3.0  # AWS charges ~$3 per dashboard per month
        monthly_dashboard_cost = dashboards * dashboard_price
        cost_breakdown["cloudwatch_dashboards_monthly_usd"] = round(monthly_dashboard_cost, 4)
        total_monthly_cost += monthly_dashboard_cost
        
        logger.info(f"CloudWatch monthly dashboards cost ({dashboards} dashboards) = {monthly_dashboard_cost:.4f}")
    
    cost_breakdown["cloudwatch_total_monthly_usd"] = round(total_monthly_cost, 4)
    
    logger.info(f"Total CloudWatch monthly cost = {total_monthly_cost:.4f}")
    logger.info("--------------------------------------------------------------------")
    
    return cost_breakdown

def get_aws_cost_estimation(architecture_json):
    """
    Calculates the total monthly cost estimate for an AWS architecture.

    This function iterates through the nodes in the provided architecture JSON,
    invokes the appropriate cost estimation function for supported services,
    and aggregates the costs. It also identifies and reports any services
    that are not supported by the cost estimator.
    """
    pricing_client = create_pricing_client()
    if not pricing_client:
        message = "Failed to create AWS pricing client. Please check your credentials."
        logger.error(message)
        return {"error": message}

    total_cost = 0
    cost_details = {}
    unsupported_service_types = []
    error_messages = []

    COST_FUNCTIONS = {
        "AmazonEC2": get_ec2_cost_estimate,
        "AmazonRDS": get_rds_cost_estimate,
        "AWSLambda": get_lambda_cost_estimate,
        "AmazonS3": get_s3_cost_estimate,
        "AmazonCloudFront": get_cloudfront_cost_estimate,
        "AmazonApiGateway": get_apigateway_cost_estimate,
        "AmazonNATGateway": get_natgateway_cost_estimate,
        "AmazonRoute53": get_route53_cost_estimate,
        "AmazonDynamoDB": get_dynamodb_cost_estimate,
        "AmazonSQS": get_sqs_cost_estimate,
        "AmazonElastiCache": get_elasticache_cost_estimate,
        "ApplicationLoadBalancer": get_alb_cost_estimate,
        "AmazonECS": get_ecs_cost_estimate,
        "AmazonSNS": get_sns_cost_estimate
    }

    # Extract all unique service types from the architecture
    all_node_types = {node['type'] for node in architecture_json.get('nodes', [])}
    logger.info(f"Services identified in architecture: {', '.join(all_node_types) or 'None'}")

    # Calculate costs for supported services that are present in the architecture
    for service_type in all_node_types:
        if service_type in COST_FUNCTIONS:
            try:
                logger.info(f"Calculating cost for {service_type}...")
                cost_function = COST_FUNCTIONS[service_type]
                # Pass only the relevant nodes to the cost function
                service_nodes = [node for node in architecture_json['nodes'] if node['type'] == service_type]
                
                # The current cost functions expect the full architecture JSON.
                # A better approach would be to pass only the relevant node, but for now we'll stick to the existing function signatures.
                service_cost = cost_function(pricing_client, architecture_json)

                cost_details[service_type] = service_cost
                
                # Find the total cost key in the returned dictionary
                total_key = next((key for key in service_cost if 'total_monthly_usd' in key), None)
                if total_key:
                    total_cost += service_cost.get(total_key, 0)
                logger.info(f"Successfully calculated cost for {service_type}.")

            except Exception as e:
                logger.error(f"Could not calculate cost for {service_type}: {e}", exc_info=True)
                error_messages.append(f"Failed to estimate cost for {service_type} due to an internal error.")
        else:
            logger.warning(f"Unsupported service type for cost estimation: '{service_type}'")
            unsupported_service_types.append(service_type)
    
    # --- Prepare Final Report ---
    notes = []
    if unsupported_service_types:
        unique_unsupported = sorted(list(set(unsupported_service_types)))
        notes.append(
            f"Cost estimation for the following services is not yet supported: {', '.join(unique_unsupported)}. "
            f"More services are being added soon. In the meantime, you can visit the "
            f"[AWS Pricing Calculator](https://calculator.aws/) for a detailed estimate."
        )
    
    if error_messages:
        notes.extend(error_messages)

    return {
        "total_monthly_cost": round(total_cost, 2),
        "cost_breakdown": cost_details,
        "notes": " ".join(notes),
        "errors": error_messages
    }

if __name__ == "__main__":
    architecture_json = {
              "title": "Cost_Estimation_Ready_Architecture",
              "nodes": [
                {
                  "id": "webAppServer",
                  "type": "AmazonEC2",
                  "label": "Web Server",
                  "region": "Asia Pacific (Mumbai)",
                  "attributes": {
                    "instanceType": "t3.micro",
                    "operatingSystem": "Linux",
                    "tenancy": "Shared",
                    "capacitystatus": "Used",
                    "preInstalledSw": "NA",
                    "termType": "OnDemand",
                    "storageGB": 15,
                    "volumeType": "gp3"

                  }
                },
                {
                  "id": "database",
                  "type": "AmazonRDS",
                  "label": "RDS Database",
                  "region": "Asia Pacific (Mumbai)",
                  "attributes": {
                    "instanceType": "db.t3.micro",
                    "databaseEngine": "PostgreSQL",
                    "termType": "OnDemand",
                    "storageGB": 100,
                    "storageType": "gp3"
                  }
                },
                {
                  "id": "storageBucket",
                  "type": "AmazonS3",
                  "label": "S3 Bucket",
                  "region": "Asia Pacific (Mumbai)",
                  "attributes": {
                    "storageGB": 100,
                    "storageClass": "Standard",
                    "numPUTRequests": 10000,
                    "numGETRequests": 50000
                  }
                },
                {
                  "id": "cloudfrontCDN",
                  "type": "AmazonCloudFront",
                  "label": "CloudFront CDN",
                  "region": "Global",
                  "attributes": {
                    "dataOutGB": 100,
                    "requestsPerMonth": 1000000
                  }
                },
              {
                  "id": "lambdaFunction",
                  "type": "AWSLambda",
                  "label": "Lambda Function",
                  "region": "Asia Pacific (Mumbai)",
                  "attributes": {
                    "requestsPerMonth": 10000000,
                    "durationMs": 100,
                    "memorySizeMB": 128
                  }
                },
                {
                  "id": "apiGateway",
                  "type": "AmazonApiGateway",
                  "label": "API Gateway",
                  "region": "Asia Pacific (Mumbai)",
                  "attributes": {
                    "apiCallsPerMonth": 2000000,
                    "websocketMinutesPerMonth": 0,
                    "cachingEnabled": "False",
                    "cacheSizeGB": 0.5
                  }
                },
                {
                  "id": "natGateway",
                  "type": "AmazonNATGateway",
                  "label": "NAT Gateway",
                  "region": "Asia Pacific (Mumbai)",
                  "attributes": {
                    "dataProcessedGBPerMonth": 150
                  }
                },
                {
                  "id": "route53",
                  "type": "AmazonRoute53",
                  "label": "Route 53 DNS",
                  "region": "Global",
                  "attributes": {
                    "hostedZones": 1,
                    "dnsQueriesPerMonth": 2000000,
                    "resourceRecordSets": 15,
                    "healthChecks": 0,
                    "geoQueriesPerMonth": 0
                  }
                },
                {
                  "id": "dynamodbTable",
                  "type": "AmazonDynamoDB",
                  "label": "DynamoDB Table",
                  "region": "Asia Pacific (Mumbai)",
                  "attributes": {
                    "capacityMode": "on-demand",
                    "storageGB": 25,
                    "readRequestUnitsPerMonth": 1500000,
                    "writeRequestUnitsPerMonth": 750000
                  }
                },
                {
                  "id": "messageQueue",
                  "type": "AmazonSQS",
                  "label": "SQS Message Queue",
                  "region": "Asia Pacific (Mumbai)",
                  "attributes": {
                    "queueType": "Standard",
                    "requestsPerMonth": 3000000
                  }
                },
                {
                  "id": "redisCache",
                  "type": "AmazonElastiCache",
                  "label": "Redis Cache",
                  "region": "Asia Pacific (Mumbai)",
                  "attributes": {
                    "instanceType": "cache.t3.micro",
                    "cacheEngine": "Redis",
                    "backupStorageGB": 5
                  }
                },
                {
                  "id": "applicationLoadBalancer",
                  "type": "ApplicationLoadBalancer",
                  "label": "Application Load Balancer",
                  "region": "Asia Pacific (Mumbai)",
                  "attributes": {
                    "newConnectionsPerSecond": 50,
                    "activeConnectionsPerMinute": 5000,
                    "bandwidthMbps": 2,
                    "ruleEvaluationsPerSecond": 1500
                  }
                },
                {
                  "id": "ecsService",
                  "type": "AmazonECS",
                  "label": "ECS Fargate Service",
                  "region": "Asia Pacific (Mumbai)",
                  "attributes": {
                    "launchType": "FARGATE",
                    "vCPU": 0.5,
                    "memoryGB": 1,
                    "tasksCount": 2,
                    "hoursPerMonth": 720
                  }
                },
                {
                  "id": "snsNotifications",
                  "type": "AmazonSNS",
                  "label": "SNS Notifications",
                  "region": "Asia Pacific (Mumbai)",
                  "attributes": {
                    "apiRequestsPerMonth": 2000000,
                    "httpNotificationsPerMonth": 1000000,
                    "smsNotificationsPerMonth": 50000,
                    "mobilePushNotificationsPerMonth": 200000,
                    "emailNotificationsPerMonth": 0
                  }
                },
                {
                  "id": "iamRole",
                  "type": "AWSIAM",
                  "label": "IAM Role",
                  "region": "Global",
                  "attributes": {
                    "userCount": 5,
                    "policyType": "Managed"
                  }
                },
              ],
              "edges": [
                { "from": "route53", "to": "cloudfrontCDN" },
                { "from": "route53", "to": "applicationLoadBalancer" },
                { "from": "applicationLoadBalancer", "to": "webAppServer" },
                { "from": "applicationLoadBalancer", "to": "ecsService" },
                { "from": "cloudfrontCDN", "to": "storageBucket" },
                { "from": "webAppServer", "to": "database" },
                { "from": "webAppServer", "to": "redisCache" },
                { "from": "ecsService", "to": "database" },
                { "from": "ecsService", "to": "redisCache" },
                { "from": "apiGateway", "to": "lambdaFunction" },
                { "from": "webAppServer", "to": "messageQueue" },
                { "from": "messageQueue", "to": "lambdaFunction" },
                { "from": "lambdaFunction", "to": "database" },
                { "from": "lambdaFunction", "to": "dynamodbTable" },
                { "from": "lambdaFunction", "to": "redisCache" },
                { "from": "lambdaFunction", "to": "snsNotifications" },
                { "from": "webAppServer", "to": "snsNotifications" },
                { "from": "natGateway", "to": "webAppServer" },
                { "from": "natGateway", "to": "database" },
                { "from": "iamRole", "to": "webAppServer" },
                { "from": "iamRole", "to": "lambdaFunction" }
              ]
            }

    # The main entry point is now get_aws_cost_estimation
    cost_estimation_result = get_aws_cost_estimation(architecture_json)
    
    # Pretty print the result
    logger.info("--- AWS Cost Estimation Result ---")
    logger.info(json.dumps(cost_estimation_result, indent=2))
    logger.info("----------------------------------") 