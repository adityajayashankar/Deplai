import os
import textwrap
from diagrams import Cluster, Edge
from custom_diagrams import Diagram
from diagrams.custom import Custom as CustomNode
from AWS.constants import maps
import AWS.constants.diagram_imports as diagram_imports
from ui.utils import clean_filename

def _wrap_label(label, width=20):
    """Wraps a label string to a given width for better diagram readability."""
    if not label:
        return ""
    return "\\n".join(textwrap.wrap(label, width=width))

def generate_aws_diagram(architecture_json, output_dir, project_title):
    """
    Generates an AWS architecture diagram from a JSON definition using corrected logic.
    """
    title = f"{project_title} - AWS Architecture"
    output_filename = f"{output_dir}/{clean_filename(project_title)}_aws_architecture"
    output_format = "png"
    
    # Construct an absolute path for the icons directory
    base_dir = os.path.dirname(os.path.abspath(__file__))
    icon_path = os.path.join(base_dir, '..', 'AWS', 'pngs') # Go up one level from AWS/ to the root

    with Diagram(title, filename=output_filename, show=False, outformat=output_format, direction="TB") as diag:
        nodes_map = {}
        clusters_map = {}

        # First, create all nodes within their type-specific clusters
        for node_data in architecture_json.get('nodes', []):
            node_id = node_data.get('id')
            node_label = _wrap_label(node_data.get('label'))
            node_type = node_data.get('type')

            if not all([node_id, node_label, node_type]):
                continue

            # Cluster by node type
            if node_type not in clusters_map:
                clusters_map[node_type] = Cluster(node_type)

            with clusters_map[node_type]:
                # Correctly look up the node class or fall back to a custom node
                lookup_key = node_type.lower().replace('amazon', '').replace('aws', '')
                node_class_name = maps.mapper.get(lookup_key)
                node_class = getattr(diagram_imports, node_class_name, None) if node_class_name else None

                if node_class:
                    nodes_map[node_id] = node_class(node_label)
                else:
                    # Fallback to CustomNode with a default icon
                    default_icon = os.path.join(icon_path, "default.png")
                    nodes_map[node_id] = CustomNode(node_label, icon_path=default_icon)
        
        # Second, create all edges using the correct operator syntax
        for edge_data in architecture_json.get('edges', []):
            from_node_id = edge_data.get('from')
            to_node_id = edge_data.get('to')
            label = edge_data.get('label', '')

            from_node = nodes_map.get(from_node_id)
            to_node = nodes_map.get(to_node_id)

            if from_node and to_node:
                from_node >> Edge(label=label, color="black", style="dashed") >> to_node

    return f"{output_filename}.{output_format}" 