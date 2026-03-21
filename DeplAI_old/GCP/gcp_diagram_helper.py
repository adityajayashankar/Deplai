import os
import re
import textwrap
from diagrams import Cluster, Edge
from custom_diagrams import Diagram
from diagrams.custom import Custom as CustomNode
from GCP.constants import maps
import GCP.constants.diagram_imports as diagram_imports
from ui.utils import clean_filename

def _wrap_label(label, width=20):
    """Wraps a label string to a given width for better diagram readability."""
    if not label:
        return ""
    return "\\n".join(textwrap.wrap(label, width=width))

def generate_gcp_diagram(architecture_json, output_dir, project_title):
    """
    Generates a GCP architecture diagram from a JSON definition.
    """
    title = f"{project_title} - GCP Architecture"
    output_filename = f"{output_dir}/{clean_filename(project_title)}_gcp_architecture"
    output_format = "png"
    
    base_dir = os.path.dirname(os.path.abspath(__file__))
    icon_path = os.path.join(base_dir, '..', 'GCP', 'pngs')

    with Diagram(title, filename=output_filename, show=False, outformat=output_format, direction="TB") as diag:
        nodes_map = {}

        nodes_by_type = {}
        for node_data in architecture_json.get('nodes', []):
            node_type = node_data.get('type', 'Unknown')
            if node_type not in nodes_by_type:
                nodes_by_type[node_type] = []
            nodes_by_type[node_type].append(node_data)
        
        for node_type, nodes_in_type in nodes_by_type.items():
            with Cluster(node_type):
                for node_data in nodes_in_type:
                    node_id = node_data.get('id')
                    node_label = _wrap_label(node_data.get('label'))
                    
                    # A more robust way to convert PascalCase and ACRONYMS to snake_case
                    s1 = re.sub('(.)([A-Z][a-z]+)', r'\\1_\\2', node_type)
                    service_key = re.sub('([a-z0-9])([A-Z])', r'\\1_\\2', s1).lower()

                    node_class_name = maps.mapper.get(service_key)
                    node_class = getattr(diagram_imports, node_class_name, None) if node_class_name else None

                    if node_class:
                        nodes_map[node_id] = node_class(node_label)
                    else:
                        default_icon = os.path.join(icon_path, "default.png")
                        nodes_map[node_id] = CustomNode(node_label, icon_path=default_icon)
        
        for edge_data in architecture_json.get('edges', []):
            from_node_id = edge_data.get('from')
            to_node_id = edge_data.get('to')
            edge_label = edge_data.get('label', '')

            from_node = nodes_map.get(from_node_id)
            to_node = nodes_map.get(to_node_id)

            if from_node and to_node:
                from_node >> Edge(label=edge_label, color="black", style="dashed") >> to_node

    return f"{output_filename}.{output_format}" 