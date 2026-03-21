import sys
import json
import requests
import time

API_CURRENCY = None
MAX_RETRIES = 3
RETRY_DELAY_SECONDS = 2

def make_api_request(url, params):
    for attempt in range(MAX_RETRIES):
        try:
            response = requests.get(url, params=params)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            print(f"  API Request failed (attempt {attempt + 1}/{MAX_RETRIES}): {e}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY_SECONDS)
            else:
                print("  Max retries reached.")
                return None
    return None

def get_all_pages(url, base_params):
    items = []
    params = base_params.copy()
    while True:
        response_data = make_api_request(url, params)
        if not response_data:
            break
        data = response_data  # Fixed: Use response_data instead of response
        items.extend(data.get("Items", []))
        next_page = data.get("NextPageLink", "")
        if not next_page:
            break
        params = {"$filter": base_params["$filter"], "api-version": base_params["api-version"], "$skiptoken": next_page.split("$skiptoken=")[-1]}
    return items

# Azure Virtual Machines
def get_vm_cost(node, config):
    global API_CURRENCY
    cost = 0.0
    node_id = node.get("id", "Unknown VM Node")
    region = node["region"]
    sku_name = node["attributes"]["vmSize"]
    os = node["attributes"]["operatingSystem"]
    hours_per_month = node["attributes"]["hoursPerMonth"]
    number_of_instances = node["attributes"]["numberOfInstances"]

    filter_query = (
        f"serviceName eq 'Virtual Machines' and "
        f"armRegionName eq '{region}' and "
        f"armSkuName eq '{sku_name}'"
    )

    url = "https://prices.azure.com/api/retail/prices"  # Fixed: Correct URL
    api_params = {"$filter": filter_query, "api-version": "2023-01-01-preview"}
    print(f"Querying Azure Retail Prices API for VM: {sku_name} in {region} for node '{node_id}'...")
    response_data = make_api_request(url, api_params)

    if not response_data:
        print(f"Error: Failed to retrieve pricing data for VM node '{node_id}'.")
        return 0.0

    data = response_data
    candidate_items = []

    for item in data.get("Items", []):
        product_name_lower = item.get("productName", "").lower()
        meter_name_lower = item.get("meterName", "").lower()
        item_type = item.get("type", "")
        unit_of_measure = item.get("unitOfMeasure", "")

        if not (item_type == "Consumption" and unit_of_measure == "1 Hour"):
            continue
        if os.lower() not in product_name_lower:
            continue
        exclusion_keywords = ["spot", "low priority", "byol", "promo", "ahb", "azure hybrid benefit", "dev/test"]
        excluded = any(keyword in product_name_lower or keyword in meter_name_lower for keyword in exclusion_keywords)
        if excluded:
            continue
        candidate_items.append(item)

    chosen_item = None
    if not candidate_items:
        print(f"No suitable PAYG pricing information found for VM node '{node_id}' ({sku_name}, OS: {os}, Region: {region}).")
    elif len(candidate_items) == 1:
        chosen_item = candidate_items[0]
        print(f"Found one suitable PAYG pricing option for VM node '{node_id}': '{chosen_item.get('productName','N/A')}'.")
    else:
        print(f"Multiple suitable PAYG pricing options found for VM node '{node_id}':")
        for i, item in enumerate(candidate_items):
            print(f"  Candidate {i+1}: {item.get('productName','N/A')} - {item.get('retailPrice','N/A')} {item.get('currencyCode','N/A')}")
        chosen_item = candidate_items[0]
        print(f"Proceeding with the first listed candidate: '{chosen_item.get('productName','N/A')}'.")

    if chosen_item:
        hourly_rate = chosen_item["retailPrice"]
        current_item_currency = chosen_item["currencyCode"]
        if API_CURRENCY is None:
            API_CURRENCY = current_item_currency
        elif API_CURRENCY != current_item_currency:
            print(f"Warning: Currency mismatch! Expected {API_CURRENCY} but found {current_item_currency}.")
        estimated_cost = hourly_rate * hours_per_month * number_of_instances
        print(f"\n--- Cost Details for Node: {node_id} (Virtual Machine) ---")
        print(f"Estimated Monthly Compute Cost: {estimated_cost:.2f} {current_item_currency}")
        print("-----------------------------------------")
        cost = estimated_cost
    return cost

# Azure Functions
def get_function_cost(node, config):
    global API_CURRENCY
    cost = 0.0
    node_id = node.get("id", "Unknown Function Node")
    attrs = node.get("attributes", {})
    region = node.get("region")
    
    monthly_execs = attrs.get("monthlyExecutions", 0)
    exec_ms = attrs.get("executionTimeMs", 0)
    mem_mb = attrs.get("memorySizeMB", 128)
    
    FREE_EXEC = 1_000_000
    FREE_GB_SEC = 400_000
    
    mem_gb = mem_mb / 1024
    exec_s = exec_ms / 1000
    total_gb_sec = monthly_execs * mem_gb * exec_s
    
    billed_execs = max(monthly_execs - FREE_EXEC, 0)
    billed_gb_sec = max(total_gb_sec - FREE_GB_SEC, 0)
    
    # Fetch pricing
    url = "https://prices.azure.com/api/retail/prices"
    filt = (
        f"serviceName eq 'Functions' "
        f"and priceType eq 'Consumption' "
        f"and armRegionName eq '{region}'"
    )
    meters = get_all_pages(url, {"$filter": filt, "api-version": "2023-01-01-preview"})
    
    exec_price = None
    gb_sec_price = None
    currency = None
    
    for m in meters:
        name = m.get("meterName", "")
        unit = m.get("unitOfMeasure", "")
        price = m.get("retailPrice", 0)
        currency = currency or m.get("currencyCode", "USD")
        sku = m.get("skuName", "")

        name_lower = name.lower()
        unit_lower = unit.lower()
        sku_lower = sku.lower()

        if sku_lower != 'standard':
            continue

        if 'total executions' in name_lower:
            if unit == '10':
                exec_price = price / 10
        
        elif 'execution time' in name_lower:
            if 'gb second' in unit_lower:
                gb_sec_price = price
    
    if exec_price is None:
        print(f"⚠️ No execution meter found. Cost for executions will be 0.")
        exec_price = 0.0
    if gb_sec_price is None:
        print(f"⚠️ No GB‑second meter found. Cost for execution time will be 0.")
        gb_sec_price = 0.0
    
    if not API_CURRENCY:
        API_CURRENCY = currency
    elif API_CURRENCY != currency:
        print(f"⚠️ Currency mismatch detected: {currency} vs {API_CURRENCY}")
    
    cost_exec = billed_execs * exec_price
    cost_mem = billed_gb_sec * gb_sec_price
    cost = cost_exec + cost_mem
    
    cost_details = {
        "azure_function_monthly_usd": cost_exec + cost_mem,
        "execution_cost": cost_exec,
        "memory_cost": cost_mem
    }
    cost_details["azure_function_total_monthly_usd"] = cost_details["azure_function_monthly_usd"]
    
    print(f"\n--- Cost for {node_id} (Functions Consumption) ---")
    print(f"Region: {region}")
    print(f"Monthly Executions: {monthly_execs}")
    print(f"Billed Executions: {billed_execs}")
    print(f"Execution Price: {exec_price:.8f} {API_CURRENCY}")
    print(f"Total GB‑seconds: {total_gb_sec:.2f}")
    print(f"Billed GB‑seconds: {billed_gb_sec:.2f}")
    print(f"GB‑second Price: {gb_sec_price:.8f} {API_CURRENCY}")
    print(f"Estimated Cost: {cost_details['azure_function_total_monthly_usd']:.2f} {API_CURRENCY}")
    print("----------------------------------------------")
    
    return cost_details

# Azure Blob Storage
def get_blob_storage_cost(node, config):
    global API_CURRENCY
    cost = 0.0
    node_id = node.get("id", "Unknown Blob Storage Node")
    attributes = node.get("attributes", {})
    region = node.get("region")

    if not region:
        print(f"Error: Region not specified for Blob Storage node '{node_id}'. Skipping.")
        return 0.0

    account_type = attributes.get("accountType", "Standard").capitalize()
    redundancy = attributes.get("redundancy", "LRS").upper()
    blob_tier = attributes.get("accessTier", "Hot").capitalize()

    capacity_gb = attributes.get("storageGB", 0.0)
    monthly_write_ops = attributes.get("monthlyWriteOperations", 0)
    monthly_read_ops = attributes.get("monthlyReadOperations", 0)
    monthly_list_ops = attributes.get("monthlyListCreateContainerOperations", 0)
    monthly_data_retrieval_gb = attributes.get("monthlyDataRetrievalGB", 0.0)

    api_sku_name_filter = f"{account_type}_{redundancy}"
    url = "https://prices.azure.com/api/retail/prices"
    total_node_cost = 0.0
    current_item_currency = None

    # Capacity Cost
    filter_capacity = (
        f"serviceName eq 'Storage' and "
        f"armRegionName eq '{region}' and "
        f"contains(tolower(productName), 'blob') and "
        f"contains(tolower(meterName), 'data stored') and "
        f"priceType eq 'Consumption'"
    )
    all_meters_data = get_all_pages(url, {"$filter": filter_capacity, "api-version": "2023-01-01-preview"})

    capacity_cost = 0.0
    for item in all_meters_data:
        meter_name_lower = item.get("meterName", "").lower()
        sku_name_lower = item.get("skuName", "").lower()
        if blob_tier.lower() in meter_name_lower and redundancy.lower() in sku_name_lower and "gb/month" in item.get("unitOfMeasure", "").lower():
            price_per_gb = item["retailPrice"]
            capacity_cost = price_per_gb * capacity_gb
            current_item_currency = item["currencyCode"]
            print(f"  Capacity: {capacity_gb} GB * {price_per_gb:.4f} {current_item_currency}/GB/month = {capacity_cost:.2f} {current_item_currency} (Meter: '{item['meterName']}')")
            break
    if not capacity_cost and capacity_gb > 0:
        print(f"Warning: No matching capacity meter found for {blob_tier} {api_sku_name_filter}. Capacity cost will be 0.")
        current_item_currency = API_CURRENCY or "USD"

    total_node_cost += capacity_cost

    # Operation Costs Helper
    def get_operation_cost(op_name, num_ops, meter_filters_list, unit_divider_default):
        op_cost = 0.0
        if num_ops == 0:
            return 0.0

        for meter_filter in meter_filters_list:
            filter_ops = (
                f"serviceName eq 'Storage' and "
                f"armRegionName eq '{region}' and "
                f"contains(tolower(productName), 'blob') and "
                f"{meter_filter} and "
                f"priceType eq 'Consumption'"
            )
            all_ops_meters = get_all_pages(url, {"$filter": filter_ops, "api-version": "2023-01-01-preview"})
            if not all_ops_meters:
                print(f"Warning: No meters found for {op_name} with filter: {filter_ops}")
            for item in all_ops_meters:
                meter_name_lower = item.get("meterName", "").lower()
                sku_name_lower = item.get("skuName", "").lower()
                if blob_tier.lower() in meter_name_lower and redundancy.lower() in sku_name_lower:
                    price_per_unit = item["retailPrice"]
                    unit_measure = item.get("unitOfMeasure", "").lower()
                    divider = unit_divider_default if "10k" in unit_measure else 1
                    op_cost = (num_ops / divider) * price_per_unit
                    nonlocal current_item_currency
                    current_item_currency = current_item_currency or item["currencyCode"]
                    print(f"  {op_name}: {num_ops:,} ops / {divider} * {price_per_unit:.6f} {current_item_currency} = {op_cost:.2f} {current_item_currency} (Meter: '{item['meterName']}')")
                    return op_cost
        
        if num_ops > 0:
            print(f"Warning: {op_name} price not found for {api_sku_name_filter}. Operation cost will be 0.")
        
        return 0.0

    # Write Operations
    write_filters = [f"contains(tolower(meterName), 'write operations') and contains(tolower(skuName), '{redundancy.lower()}')"]
    write_ops_cost = get_operation_cost("Write Operations", monthly_write_ops, write_filters, 10000)
    total_node_cost += write_ops_cost

    # Read Operations
    read_filters = [f"contains(tolower(meterName), 'read operations') and contains(tolower(skuName), '{redundancy.lower()}')"]
    read_ops_cost = get_operation_cost("Read Operations", monthly_read_ops, read_filters, 10000)
    total_node_cost += read_ops_cost

    # List Operations
    list_filters = [f"contains(tolower(meterName), 'list and create container operations') and contains(tolower(skuName), '{redundancy.lower()}')"]
    list_ops_cost = get_operation_cost("List/Create Operations", monthly_list_ops, list_filters, 10000)
    total_node_cost += list_ops_cost

    # Data Retrieval
    retrieval_cost = 0.0
    if (blob_tier in ["Cool", "Archive"]) and monthly_data_retrieval_gb > 0:
        retrieval_filters = [f"contains(tolower(meterName), 'data retrieval') and unitOfMeasure eq '1 GB'"]
        retrieval_cost = get_operation_cost(f"{blob_tier} Data Retrieval", monthly_data_retrieval_gb, retrieval_filters, 1)
        total_node_cost += retrieval_cost

    final_currency = API_CURRENCY or current_item_currency or 'USD'
    if API_CURRENCY is None:
        API_CURRENCY = current_item_currency
    elif current_item_currency and API_CURRENCY != current_item_currency:
        print(f"Warning: Currency mismatch for Blob Storage node '{node_id}'.")

    print(f"\n--- Cost Details for Node: {node_id} (Azure Blob Storage) ---")
    print(f"Region: {region}, Account: {account_type} {redundancy}, Tier: {blob_tier}")
    print(f"Capacity Cost: {capacity_cost:.2f} {final_currency}")
    print(f"Write Operations Cost: {write_ops_cost:.2f} {final_currency}")
    print(f"Read Operations Cost: {read_ops_cost:.2f} {final_currency}")
    print(f"List Operations Cost: {list_ops_cost:.2f} {final_currency}")
    if retrieval_cost > 0:
        print(f"Data Retrieval Cost: {retrieval_cost:.2f} {final_currency}")
    print(f"Estimated Total Monthly Cost: {total_node_cost:.2f} {final_currency}")
    print("--------------------------------------------------")

    cost_details = {
        "capacity_cost_usd": capacity_cost,
        "write_ops_cost_usd": write_ops_cost,
        "read_ops_cost_usd": read_ops_cost,
        "list_ops_cost_usd": list_ops_cost,
        "data_retrieval_cost_usd": retrieval_cost
    }
    cost_details["azure_blob_total_monthly_usd"] = total_node_cost
    
    return cost_details

# Azure Virtual Network
def get_virtual_network_cost(node, config):
    global API_CURRENCY
    cost_details = {}
    node_id = node.get("id", "Unknown Virtual Network Node")
    attributes = node.get("attributes", {})
    region = node.get("region")

    if not region:
        print(f"Error: Region not specified for Virtual Network node '{node_id}'. Skipping.")
        return 0.0

    outbound_data_gb = attributes.get("outboundDataGB", 0.0)
    static_public_ips = attributes.get("staticPublicIPs", 0)
    hours_per_month = attributes.get("hoursPerMonth", 730)

    url = "https://prices.azure.com/api/retail/prices"
    total_node_cost = 0.0
    current_item_currency = None

    # Outbound Data Transfer Cost
    outbound_cost = 0.0
    if outbound_data_gb > 0:
        filter_data = (
            f"serviceName eq 'Bandwidth' and "
            f"armRegionName eq '{region}' and "
            f"contains(meterName, 'Data Transfer Out') and "
            f"priceType eq 'Consumption'"
        )
        all_meters_data = get_all_pages(url, {"$filter": filter_data, "api-version": "2023-01-01-preview"})

        price_found = False
        best_item = None
        for item in all_meters_data:
            meter_name_lower = item.get("meterName", "").lower()
            if "data transfer out" in meter_name_lower and "gb" in item.get("unitOfMeasure", "").lower():
                # Skip meters for specific destinations or inter-zone transfers to get the general egress price
                if ' to ' in meter_name_lower or 'inter-zonal' in meter_name_lower or 'inter-continental' in meter_name_lower:
                    continue
                
                # Skip meters with a zero price
                if item["retailPrice"] == 0:
                    continue

                best_item = item
                break  # Found a suitable meter

        if best_item:
            price_per_gb = best_item["retailPrice"]
            # Apply free tier (first 100 GB free)
            billed_data_gb = max(0, outbound_data_gb - 100)
            outbound_cost = price_per_gb * billed_data_gb
            current_item_currency = best_item["currencyCode"]
            print(f"  Outbound Data: {billed_data_gb:.2f} GB * {price_per_gb:.4f} {current_item_currency}/GB = {outbound_cost:.2f} {current_item_currency} (Meter: '{best_item['meterName']}')")
            price_found = True

        if not price_found and outbound_data_gb > 100:
            print(f"Warning: No outbound data pricing found for {region}. Outbound data cost will be 0.")

        total_node_cost += outbound_cost

    # Static Public IP Cost
    ip_cost = 0.0
    if static_public_ips > 0:
        filter_ip = (
            f"serviceFamily eq 'Networking' and "
            f"armRegionName eq '{region}'"
        )
        all_meters_data = get_all_pages(url, {"$filter": filter_ip, "api-version": "2023-01-01-preview"})

        ip_address_meters = [
            item for item in all_meters_data
            if item.get('serviceName') == 'Virtual Network'
        ]

        price_found = False
        best_item = None
        for item in ip_address_meters:
            meter_name_lower = item.get("meterName", "").lower()
            sku_name_lower = item.get("skuName", "").lower()
            if "static" in meter_name_lower and "hour" in item.get("unitOfMeasure", "").lower():
                if "standard" in sku_name_lower:
                    best_item = item
                    break
                if not best_item:
                    best_item = item
        
        if best_item:
            price_per_hour = best_item["retailPrice"]
            ip_cost = price_per_hour * hours_per_month * static_public_ips
            current_item_currency = current_item_currency or best_item["currencyCode"]
            print(f"  Static Public IPs: {static_public_ips} IPs * {hours_per_month} hours * {price_per_hour:.6f} {current_item_currency}/hour = {ip_cost:.2f} {current_item_currency} (Meter: '{best_item['meterName']}')")
            price_found = True

        if not price_found and static_public_ips > 0:
            print(f"Warning: No static IP pricing found for {region}. Static IP cost will be 0.")

        total_node_cost += ip_cost

    # VNet Peering Cost
    peering_cost = 0.0
    peering_filters = [f"contains(tolower(meterName), 'vnet peering') and priceType eq 'Consumption'"]
    peering_meters = get_all_pages(url, {"$filter": peering_filters, "api-version": "2023-01-01-preview"})
    for item in peering_meters:
        price = item["retailPrice"]
        current_item_currency = current_item_currency or item["currencyCode"]
        peering_cost += price

    final_currency = API_CURRENCY or current_item_currency or 'USD'
    if API_CURRENCY is None:
        API_CURRENCY = current_item_currency
    elif current_item_currency and API_CURRENCY != current_item_currency:
        print(f"Warning: Currency mismatch for Virtual Network node '{node_id}'.")

    print(f"\n--- Cost Details for Node: {node_id} (Azure Virtual Network) ---")
    print(f"Region: {region}")
    print(f"Outbound Data Cost: {outbound_cost:.2f} {final_currency}")
    print(f"Static Public IP Cost: {ip_cost:.2f} {final_currency}")
    print(f"VNet Peering Cost: {peering_cost:.2f} {final_currency}")
    print(f"Estimated Total Monthly Cost: {total_node_cost:.2f} {final_currency}")
    print("--------------------------------------------------")

    cost_details = {
        "outbound_data_cost_usd": outbound_cost,
        "static_ip_cost_usd": ip_cost,
        "peering_cost_usd": peering_cost
    }
    total_cost = outbound_cost + ip_cost + peering_cost
    cost_details["azure_vnet_total_monthly_usd"] = total_cost

    return cost_details

# Azure SQL Database
def get_sql_database_cost(node, config):
    global API_CURRENCY
    cost = 0.0
    node_id = node.get("id", "Unknown SQL Database Node")
    attributes = node.get("attributes", {})
    region = node.get("region")

    if not region:
        print(f"Error: Region not specified for SQL Database node '{node_id}'. Skipping.")
        return 0.0

    service_tier = attributes.get("serviceTier", "Standard")
    performance_level = attributes.get("performanceLevel", "S0")
    storage_gb = attributes.get("storageGB", 250)

    url = "https://prices.azure.com/api/retail/prices"
    filter_query = (
        f"serviceName eq 'SQL Database' and "
        f"armRegionName eq '{region}' and "
        f"contains(tolower(productName), '{service_tier.lower()}') and "
        f"contains(tolower(meterName), '{performance_level.lower()}') and "
        f"priceType eq 'Consumption'"
    )
    api_params = {"$filter": filter_query, "api-version": "2023-01-01-preview"}
    print(f"Querying Azure Retail Prices API for SQL Database: {service_tier} {performance_level} in {region} for node '{node_id}'...")
    response_data = make_api_request(url, api_params)

    if not response_data:
        print(f"Error: Failed to retrieve pricing data for SQL Database node '{node_id}'.")
        return 0.0

    data = response_data
    candidate_items = []

    for item in data.get("Items", []):
        if "dtu" in item.get("meterName", "").lower() or "vcore" in item.get("meterName", "").lower():
            candidate_items.append(item)

    chosen_item = None
    if not candidate_items:
        print(f"No suitable pricing information found for SQL Database node '{node_id}' ({service_tier} {performance_level}, Region: {region}).")
    elif len(candidate_items) == 1:
        chosen_item = candidate_items[0]
        print(f"Found one suitable pricing option for SQL Database node '{node_id}': '{chosen_item.get('productName','N/A')}'.")
    else:
        print(f"Multiple suitable pricing options found for SQL Database node '{node_id}':")
        for i, item in enumerate(candidate_items):
            print(f"  Candidate {i+1}: {item.get('productName','N/A')} - {item.get('retailPrice','N/A')} {item.get('currencyCode','N/A')}")
        chosen_item = candidate_items[0]
        print(f"Proceeding with the first listed candidate: '{chosen_item.get('productName','N/A')}'.")

    if chosen_item:
        hourly_rate = chosen_item["retailPrice"]
        current_item_currency = chosen_item["currencyCode"]
        if API_CURRENCY is None:
            API_CURRENCY = current_item_currency
        elif API_CURRENCY != current_item_currency:
            print(f"Warning: Currency mismatch! Expected {API_CURRENCY} but found {current_item_currency}.")

        estimated_cost = hourly_rate * 730
        print(f"  SQL Database: {service_tier} {performance_level} * 730 hours * {hourly_rate:.4f} {current_item_currency}/hour = {estimated_cost:.2f} {current_item_currency} (Meter: '{chosen_item['meterName']}')")

        # Storage Cost
        storage_cost = 0.0
        if storage_gb > 0:
            storage_filter = (
                f"serviceName eq 'SQL Database' and "
                f"armRegionName eq '{region}' and "
                f"contains(tolower(productName), '{service_tier.lower()}') and "
                f"contains(tolower(meterName), 'data stored') and "
                f"priceType eq 'Consumption'"
            )
            storage_response = get_all_pages(url, {"$filter": storage_filter, "api-version": "2023-01-01-preview"})
            
            storage_price_found = False
            if storage_response:
                # This is a simplification; pricing can be tiered. Taking the first result.
                storage_meter = storage_response[0]
                price_per_gb_month = storage_meter['retailPrice']
                storage_cost = price_per_gb_month * storage_gb
                print(f"  Storage: {storage_gb} GB * {price_per_gb_month:.4f} {current_item_currency}/GB/month = {storage_cost:.2f} {current_item_currency} (Meter: '{storage_meter['meterName']}')")
                storage_price_found = True

            if not storage_price_found:
                print(f"Warning: No storage pricing found for SQL Database '{node_id}'. Storage cost will be 0.")

        cost = estimated_cost + storage_cost
        print(f"Estimated Total Monthly Cost for SQL Database: {cost:.2f} {current_item_currency}")

        cost_details = {
            "db_compute_cost_usd": estimated_cost,
            "db_storage_cost_usd": storage_cost,
            "azure_sql_total_monthly_usd": cost
        }
        return cost_details

    print(f"Error: No pricing information found for SQL Database node '{node_id}'.")
    return {"error": "Could not calculate SQL DB cost", "azure_sql_total_monthly_usd": 0.0}

def get_azure_cost_estimation(architecture_json):
    """
    Calculates the total monthly cost estimate for an Azure architecture.
    """
    total_cost = 0
    cost_details = {}
    unsupported_service_types = []
    error_messages = []

    COST_FUNCTIONS = {
        "VirtualMachines": get_vm_cost,
        "AzureFunction": get_function_cost,
        "BlobStorage": get_blob_storage_cost,
        "VirtualNetwork": get_virtual_network_cost,
        "SQLDatabase": get_sql_database_cost,
    }

    all_node_types = {node['type'] for node in architecture_json.get('nodes', [])}
    print(f"Services identified in architecture: {', '.join(all_node_types) or 'None'}")

    for service_type in all_node_types:
        if service_type in COST_FUNCTIONS:
            try:
                print(f"Calculating cost for {service_type}...")
                cost_function = COST_FUNCTIONS[service_type]
                
                # Unlike AWS, here we iterate and pass each specific node
                for node in architecture_json['nodes']:
                    if node['type'] == service_type:
                        service_cost = cost_function(node, architecture_json)
                        
                        node_id = node.get("id", f"Unnamed_{service_type}")
                        cost_details[node_id] = service_cost
                        
                        total_key = next((key for key in service_cost if 'total_monthly_usd' in key), None)
                        if total_key:
                            total_cost += service_cost.get(total_key, 0)
                        print(f"Successfully calculated cost for node {node_id} ({service_type}).")

            except Exception as e:
                print(f"Could not calculate cost for {service_type}: {e}")
                error_messages.append(f"Failed to estimate cost for {service_type} due to an internal error.")
        else:
            print(f"Unsupported service type for cost estimation: '{service_type}'")
            unsupported_service_types.append(service_type)
    
    notes = []
    if unsupported_service_types:
        unique_unsupported = sorted(list(set(unsupported_service_types)))
        notes.append(
            f"Cost estimation for the following services is not yet supported: {', '.join(unique_unsupported)}. "
            f"More services are being added soon. In the meantime, you can visit the Azure Pricing Calculator."
        )
    
    if error_messages:
        notes.extend(error_messages)

    return {
        "total_monthly_cost": round(total_cost, 2),
        "cost_breakdown": cost_details,
        "notes": " ".join(notes),
        "errors": error_messages
    }

def main():
    if len(sys.argv) < 2:
        print("Usage: python azure_cost_estimation.py <path_to_architecture.json>")
        sys.exit(1)
    
    file_path = sys.argv[1]
    try:
        with open(file_path, 'r') as f:
            architecture_data = json.load(f)
    except FileNotFoundError:
        print(f"Error: The file '{file_path}' was not found.")
        sys.exit(1)
    except json.JSONDecodeError:
        print(f"Error: The file '{file_path}' is not a valid JSON file.")
        sys.exit(1)

    cost_result = get_azure_cost_estimation(architecture_data)
    
    print("\n\n--- Final Azure Cost Estimation Report ---")
    print(json.dumps(cost_result, indent=2))
    print("------------------------------------------")

if __name__ == "__main__":
    main()