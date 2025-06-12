# AI-Powered GitHub PR Reviewer

A GitHub App that uses Google's Vertex AI with Gemini to provide intelligent code reviews for pull requests.

## Features

- **AI-Powered Code Review**: Uses Google's Vertex AI with Gemini to analyze code
- **Two Simple Commands**:
  - `/what`: Provides a summary of changes in the PR
  - `/review`: Performs a comprehensive code review
- **Intelligent Analysis**:
  - Identifies bugs and logical errors
  - Detects potential security vulnerabilities
  - Flags performance issues
  - Suggests code improvements and best practices
- **Supports Multiple Languages**: Works with various programming languages
- **Focused Feedback**: Only reports issues with high confidence

## Setup

1. **Create a GitHub App**
   - Go to [GitHub Developer Settings](https://github.com/settings/apps)
   - Click "New GitHub App"
   - Set a name (e.g., "PR Reviewer")
   - Set the Homepage URL to your repository URL
   - Set the Webhook URL to your server URL (e.g., `https://your-domain.com`)
   - Set the Webhook Secret (generate a random string)
   - Under "Permissions", set:
     - Pull requests: Read & Write
     - Contents: Read-only
   - Under "Subscribe to events", select:
     - Pull request
     - Installation
   - Click "Create GitHub App"
   - Generate a private key and download it

2. **Configure Environment Variables**
   - Copy `.env.example` to `.env`
   - Fill in the values from your GitHub App settings
   - For the private key, copy the contents of the downloaded `.pem` file and format it as a single line with `\n` for newlines

3. **Install Dependencies**
   ```bash
   npm install
   ```

4. **Run the App**
   ```bash
   npm start
   ```

   For development with auto-reload:
   ```bash
   npm run dev
   ```

## Development

- The main application logic is in `index.js`
- The app listens for `pull_request.opened` events
- Reviews are submitted using the GitHub API

## Deployment

You can deploy this app to any Node.js hosting platform like:
- Heroku
- Vercel
- AWS Lambda
- Google Cloud Run
- Google Cloud Functions

Make sure to set the environment variables in your hosting platform's configuration.

### Google Cloud Functions

1. Deploy using [`function.js`](function.js) as the entry point:
   ```bash
   gcloud functions deploy probotApp \
     --runtime=nodejs18 --trigger-http --entry-point=probotApp
   ```
2. Set all required environment variables in the function configuration.


## License

MIT
