# AI-Powered GitHub PR Reviewer

A GitHub App that uses Google's GenAI (Vertex AI) with Gemini to provide intelligent code reviews for pull requests. Requires **Node.js 18+**.

## Features

- **AI-Powered Code Review**: Uses Google's GenAI with Gemini to analyze code
- **Commands**:
  - `/review`: Generates a PR summary and performs a deep code review
  - `/what`: (optional) Only produce the summary of changes
  - Add the `ai-review` label to a PR to trigger an automatic review
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
     - Issue comment
     - Installation
   - Click "Create GitHub App"
   - Generate a private key and download it
   - Deploy your `gh-review` service and update the GitHub App's webhook URL
   - Use the generated webhook secret and credentials in your `.env` file

2. **Configure Environment Variables**
   - Copy `.env.example` to `.env`
   - Fill in the values from your GitHub App settings
   - Set `APP_ID`, `PRIVATE_KEY`, and `WEBHOOK_SECRET` with the credentials from the app you created
   - For the private key, copy the contents of the downloaded `.pem` file and format it as a single line with `\n` for newlines
   - (Optional) Set `GENAI_MODEL` to override the default Gemini model
   - (Optional) Set `PORT` for local testing (default `3000`)
   - (Optional) Tune limits with:
     - `MAX_FILES_TO_PROCESS` (default 20)
     - `MAX_DIFF_LENGTH`, `MAX_DIFF_LINES`, `MAX_FILE_SIZE`, and
       `MAX_CONTEXT_LINES`
   - (Optional) `TRIGGER_LABEL` overrides the label name used to start a review (default `ai-review`)

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

### Google Cloud Run

1. Build and deploy your container image as you normally would.
2. Ensure the container executes `npm start` (which runs `node index.js`).

Make sure to set the environment variables in your hosting platform's configuration.


## License

MIT
