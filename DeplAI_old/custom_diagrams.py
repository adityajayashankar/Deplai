import io
import os
from diagrams import Diagram as BaseDiagram
from diagrams import Cluster
from graphviz import Digraph
import contextvars

# Global contexts for a diagrams and a cluster.
__diagram = contextvars.ContextVar("diagrams")
__cluster = contextvars.ContextVar("cluster")

def getdiagram() -> "Diagram":
    try:
        return __diagram.get()
    except LookupError:
        return None

def setdiagram(diagram: "Diagram"):
    __diagram.set(diagram)

def getcluster() -> "Cluster":
    try:
        return __cluster.get()
    except LookupError:
        return None

def setcluster(cluster: "Cluster"):
    __cluster.set(cluster)

class Diagram(BaseDiagram):
    def __init__(self, *args, output_buffer: io.BytesIO = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.output_buffer = output_buffer

    def __enter__(self):
        super().__enter__()  # Call parent method to set up context
        setdiagram(self)
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.render()
        if not self.output_buffer:
            os.remove(self.filename)
        setdiagram(None)

    def render(self) -> None:
        if isinstance(self.outformat, list):
            for one_format in self.outformat:
                if self.output_buffer:
                    self.output_buffer.write(self.dot.pipe(format=one_format))
                else:
                    self.dot.render(format=one_format, view=self.show, quiet=True)
        else:
            if self.output_buffer:
                self.output_buffer.write(self.dot.pipe(format=self.outformat))
            else:
                self.dot.render(format=self.outformat, view=self.show, quiet=True)
