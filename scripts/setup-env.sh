#!/bin/bash
# setup-env.sh - Interactive script to setup environment variables

echo "LazyDev Environment Setup"
echo "========================="

if [ -f .env ]; then
  echo "A .env file already exists. Backing up to .env.backup..."
  cp .env .env.backup
fi

echo "Copying .env.example to .env..."
cp .env.example .env

echo ""
echo "--- Git Author Configuration ---"
echo "These credentials will be used for all automated commits created by LazyDev."

read -p "Enter Git User Name: " git_name
read -p "Enter Git User Email: " git_email

# Replace the empty git values in .env with the user input
if [[ "$OSTYPE" == "darwin"* ]]; then
  # Mac OSX sed
  sed -i '' "s/GIT_USER_NAME=\"\"/GIT_USER_NAME=\"$git_name\"/g" .env
  sed -i '' "s/GIT_USER_EMAIL=\"\"/GIT_USER_EMAIL=\"$git_email\"/g" .env
else
  # Linux sed
  sed -i "s/GIT_USER_NAME=\"\"/GIT_USER_NAME=\"$git_name\"/g" .env
  sed -i "s/GIT_USER_EMAIL=\"\"/GIT_USER_EMAIL=\"$git_email\"/g" .env
fi

echo ""
echo "--- GitHub App Configuration ---"
read -p "Enter GitHub App ID (Press enter to skip and manually edit later): " github_app_id
if [ -n "$github_app_id" ]; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/GITHUB_APP_ID=your_app_id/GITHUB_APP_ID=$github_app_id/g" .env
  else
    sed -i "s/GITHUB_APP_ID=your_app_id/GITHUB_APP_ID=$github_app_id/g" .env
  fi
fi

echo ""
echo "Setup complete! Open the .env file in your editor to add any remaining secrets like OPENAI_API_KEY and GITHUB_APP_PRIVATE_KEY."
