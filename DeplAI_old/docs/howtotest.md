<div align="center">
  🚩🧡🕉️ || जय श्री राम || 🕉️🧡🚩
</div>

---

# How to Test the DeplAI Project with Jenkins

This guide provides step-by-step instructions to set up a local Jenkins environment using Docker and run the full integration test suite for the DeplAI project.

## Prerequisites

- **Docker Desktop:** Ensure Docker Desktop is installed and running on your local machine (Windows, macOS, or Linux). All commands will be run from your local terminal.
- **Git:** Ensure you have Git installed to push changes to your repository.

---

## Step 1: Build the Custom Jenkins Image

The project includes a `jenkins.Dockerfile` that creates a custom Jenkins image pre-loaded with Docker, Docker Compose, and Sudo for running the pipeline.

First, build this image from the root directory of the project:

```bash
docker build -t deplai-jenkins -f jenkins.Dockerfile .
```
*This command only needs to be run once, or whenever the `jenkins.Dockerfile` is updated.*

---

## Step 2: Run the Jenkins Container

Next, start the Jenkins container. This command maps the required ports and volumes, including the Docker socket, which allows Jenkins to orchestrate Docker containers on your host machine.

```bash
docker run --name jenkins-ci -d -p 8080:8080 -p 50000:50000 -v jenkins_home:/var/jenkins_home -v /var/run/docker.sock:/var/run/docker.sock deplai-jenkins
```

- `-p 8080:8080`: Maps the Jenkins web interface port.
- `-v jenkins_home...`: Creates a persistent volume for your Jenkins configuration, so you don't lose jobs or settings if you restart the container.
- `-v /var/run/docker.sock...`: The "Docker-out-of-Docker" socket connection.

---

## Step 3: Initial Jenkins Setup

You need to perform a one-time setup to unlock Jenkins and create your user.

1.  **Get Admin Password:**
    Run the following command to get the initial, automatically generated admin password from the container's logs:
    ```bash
    docker logs jenkins-ci
    ```
    Look for a long alphanumeric string surrounded by asterisks. Copy this password.

2.  **Unlock Jenkins:**
    - Open your web browser and navigate to `http://localhost:8080`.
    - Paste the password into the "Administrator password" field and click **Continue**.

3.  **Install Plugins:**
    - On the "Customize Jenkins" page, click **"Install suggested plugins"**. This will install a standard, useful set of plugins.

4.  **Create Admin User:**
    - Once plugins are installed, you will be prompted to create your first admin user. Fill out the form and click **"Save and Continue"**.

5.  **Instance Configuration:**
    - You can leave the Jenkins URL as the default (`http://localhost:8080/`). Click **"Save and Finish"**.
    - Click **"Start using Jenkins"** to go to the main dashboard.

---

## Step 4: Create a GitHub Personal Access Token (PAT)

Because the DeplAI repository is private, Jenkins needs a way to authenticate with GitHub. You must use a Personal Access Token.

1.  **Navigate to GitHub:**
    - Go to your GitHub account settings.
    - Click **<> Developer settings** in the left sidebar.
    - Click **Personal access tokens** > **Tokens (classic)**.

2.  **Generate a New Token:**
    - Click **"Generate new token"** (and select "classic" if prompted).
    - **Note:** Give it a descriptive name (e.g., `jenkins-deplai-token`).
    - **Expiration:** Set an appropriate expiration date.
    - **Scopes:** Check the entire **`repo`** scope. This is crucial as it grants permission to access and clone private repositories.
    - Click **"Generate token"**.

3.  **Copy the Token:**
    - **Important:** GitHub only shows the token once. Copy it immediately and save it for the next step.

---

## Step 5: Create and Configure the Jenkins Pipeline

Now, create the pipeline job in Jenkins that will run the tests.

1.  **Create Credentials in Jenkins:**
    - On the Jenkins dashboard, go to **Manage Jenkins** > **Credentials**.
    - Click on **(global)** under the Stores scope.
    - Click **"Add Credentials"** on the left.
    - **Kind:** Select **Username with password**.
    - **Username:** Your GitHub username (e.g., `VinsmokeSomya`).
    - **Password:** Paste the **GitHub Personal Access Token** you just generated.
    - **ID:** Give it a simple, descriptive ID (e.g., `github-credentials`).
    - Click **Create**.

2.  **Create the Pipeline Job:**
    - Go back to the main Jenkins dashboard.
    - Click **"New Item"**.
    - **Enter an item name:** `DeplAI-CI`.
    - Select **"Pipeline"** and click **OK**.

3.  **Configure the Pipeline Source:**
    - Scroll down to the **"Pipeline"** section.
    - **Definition:** Change the dropdown to **"Pipeline script from SCM"**.
    - **SCM:** Select **"Git"**.
    - **Repository URL:** Enter the HTTPS URL of your repository (e.g., `https://github.com/VinsmokeSomya/DeplAI.git`).
    - **Credentials:** Select the credential you just created from the dropdown (`VinsmokeSomya (github-credentials)`). The red error message should disappear.
    - **Branch Specifier:** Ensure it is `*/main`.
    - **Script Path:** Leave this as `Jenkinsfile`.

4.  **Save:**
    - Click **Save** to finish the configuration.

---

## Step 6: Run the Test Pipeline!

You are now ready to run the tests.

1.  **Push All Changes:** Make sure you have pushed the latest versions of the `Jenkinsfile` and `jenkins.Dockerfile` to your GitHub repository.
2.  **Build Now:** On the pipeline status page, click **"Build Now"** on the left sidebar.

Jenkins will now clone your repository, execute the `Jenkinsfile`, and run the complete test suite in parallel. You can click on the build number and then **"Console Output"** to see the live logs of the entire process. 
