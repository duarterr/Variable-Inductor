"""
setup.py - Creates a virtual environment and installs all dependencies.

Usage:
    python setup.py
"""

import subprocess
import sys
import os
import venv

VENV_DIR = ".venv"
REQUIREMENTS_FILE = "requirements.txt"


def create_venv(venv_dir: str) -> None:
    print(f"Creating virtual environment in '{venv_dir}'...")
    venv.create(venv_dir, with_pip=True)
    print("Virtual environment created.")


def get_pip_executable(venv_dir: str) -> str:
    if sys.platform == "win32":
        return os.path.join(venv_dir, "Scripts", "pip.exe")
    return os.path.join(venv_dir, "bin", "pip")


def install_requirements(pip_executable: str, requirements_file: str) -> None:
    print(f"Installing requirements from '{requirements_file}'...")
    subprocess.check_call([pip_executable, "install", "-r", requirements_file])
    print("All dependencies installed successfully.")


def main() -> None:
    if not os.path.isfile(REQUIREMENTS_FILE):
        print(f"Error: '{REQUIREMENTS_FILE}' not found.")
        sys.exit(1)

    if not os.path.isdir(VENV_DIR):
        create_venv(VENV_DIR)
    else:
        print(f"Virtual environment '{VENV_DIR}' already exists, skipping creation.")

    pip = get_pip_executable(VENV_DIR)
    install_requirements(pip, REQUIREMENTS_FILE)

    activate = (
        os.path.join(VENV_DIR, "Scripts", "activate")
        if sys.platform == "win32"
        else f"source {os.path.join(VENV_DIR, 'bin', 'activate')}"
    )
    print(f"\nSetup complete. Activate the environment with:\n    {activate}")


if __name__ == "__main__":
    main()
