# Use the official Jenkins LTS image with Java 17 as the base
FROM jenkins/jenkins:lts-jdk17

# Switch to the root user to install software
USER root

# Install prerequisites and the Docker CLI
RUN apt-get update && apt-get install -y curl gnupg lsb-release
RUN install -m 0755 -d /etc/apt/keyrings
RUN curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
RUN chmod a+r /etc/apt/keyrings/docker.gpg
RUN echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
  $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
RUN apt-get update && apt-get install -y docker-ce-cli

# Install Docker Compose
RUN DOCKER_COMPOSE_VERSION=v2.27.0 && \
    curl -L "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-$(uname -m)" -o /usr/local/bin/docker-compose && \
    chmod +x /usr/local/bin/docker-compose

# Create a docker group with a static GID and add the jenkins user to it.
# This grants the necessary permissions to use the Docker socket mounted from the host.
RUN groupadd -g 999 docker && usermod -aG docker jenkins

# Install sudo and grant passwordless sudo to the jenkins user.
# This is a more robust way to handle docker permissions.
RUN apt-get update && apt-get install -y sudo && \
    echo "jenkins ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# Install Python 3, pip, and venv for running test scripts on the Jenkins agent itself
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv

# Switch back to the jenkins user
USER jenkins 