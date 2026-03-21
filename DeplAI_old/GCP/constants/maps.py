# GCP Service Categories Mapper
# Maps service identifiers to their display names

mapper = {
    # API Management
    'api_gateway': 'APIGateway',
    'cloud_endpoints': 'Endpoints',
    'endpoints': 'Endpoints',
    
    # Analytics
    'bigquery': 'BigQuery',
    'data_fusion': 'DataFusion',
    'dataflow': 'Dataflow',
    'dataproc': 'Dataproc',
    'pubsub': 'PubSub',
    'pub_sub': 'PubSub',
    'composer': 'Composer',

    # Compute
    'app_engine': 'AppEngine',
    'cloud_functions': 'Functions',
    'functions': 'Functions',
    'compute_engine': 'ComputeEngine',
    'kubernetes_engine': 'KubernetesEngine',
    'gke': 'KubernetesEngine',
    'cloud_run': 'Run',
    'run': 'Run',

    # Database
    'bigtable': 'Bigtable',
    'big_table': 'Bigtable',
    'datastore': 'Datastore',
    'firestore': 'Firestore',
    'memorystore': 'Memorystore',
    'cloud_sql': 'SQL',
    'sql': 'SQL',
    'spanner': 'Spanner',

    # Developer Tools
    'cloud_build': 'Build',
    'build': 'Build',
    'container_registry': 'ContainerRegistry',
    'gcr': 'ContainerRegistry',
    'artifact_registry': 'ArtifactRegistry',
    'cloud_source_repositories': 'SourceRepositories',
    'source_repositories': 'SourceRepositories',
    'cloud_scheduler': 'CloudScheduler',

    # IoT
    'iot_core': 'IotCore',
    'cloud_iot_core': 'IotCore',

    # ML & AI
    'vertex_ai': 'AIPlatform',
    'ai_platform': 'AIPlatform',
    'ai_platform_prediction': 'AIPlatform',
    'ai_platform_training': 'AIPlatform',
    'automl': 'Automl',
    'natural_language_api': 'NaturalLanguageAPI',
    'vision_api': 'VisionAPI',
    'speech_to_text': 'SpeechToText',
    
    # Migration
    'storage_transfer_service': 'TransferService',
    'transfer_service': 'TransferService',
    
    # Networking
    'virtual_private_cloud': 'VPC',
    'vpc': 'VPC',
    'cloud_armor': 'Armor',
    'armor': 'Armor',
    'cloud_cdn': 'CDN',
    'cdn': 'CDN',
    'cloud_dns': 'DNS',
    'dns': 'DNS',
    'cloud_load_balancing': 'LoadBalancing',
    'load_balancing': 'LoadBalancing',
    'load_balancer': 'LoadBalancing',
    'cloud_nat': 'NAT',
    'nat': 'NAT',
    'cloud_router': 'Router',
    'router': 'Router',
    
    # Operations (Stackdriver)
    'cloud_monitoring': 'Monitoring',
    'monitoring': 'Monitoring',
    'cloud_logging': 'Logging',
    'logging': 'Logging',
    'cloud_audit_logs': 'Logging',
    'cloud_trace': 'Trace',
    'trace': 'Trace',
    
    # Security
    'secret_manager': 'SecretManager',
    'cloud_iam': 'IAM',
    'iam': 'IAM',
    'key_management_service': 'KMS',
    'kms': 'KMS',
    'cloud_kms': 'KMS',
    'security_command_center': 'SecurityCommandCenter',
    
    # Storage
    'cloud_storage': 'Storage',
    'storage': 'Storage',
    'gcs': 'Storage',
    'filestore': 'Filestore',
} 