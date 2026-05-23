import asyncio

from param_selector import select_params


async def test() -> None:
    params = await select_params(
        service_type="ec2",
        repo_context={"language": "python", "framework": "fastapi", "project_name": "myapp"},
        user_customizations={"instance_type": "t3.micro"},
        aws_region="us-east-1",
        project_id="proj-test-001",
    )
    print("Params returned:", params)
    assert "instance_name" in params
    assert "instance_type" in params
    assert params["aws_region"] == "us-east-1"
    assert params["project_id"] == "proj-test-001"
    print("PASS")


asyncio.run(test())
