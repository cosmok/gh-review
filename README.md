# AI-Powered GitHub PR Reviewer

[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run)

A GitHub App that uses generative AI models like Gemini, GPT, and Claude to provide intelligent code reviews for pull requests. Requires **Node.js 18+**.

## Features

- **AI-Powered Code Review**: Analyze code using your choice of Gemini, GPT, or Claude models
- **Commands**:
  - `/review`: Generates a PR summary and performs a deep code review
  - `/what`: (optional) Only produce the summary of changes
- **Inline Comment Replies**: Respond to review comment threads with `/review` to analyze a specific diff snippet
- **Configurable Triggers**: Enable reactions to custom comment keywords or pull request labels
- **Intelligent Analysis**:
  - Identifies bugs and logical errors
  - Detects potential security vulnerabilities
  - Flags performance issues
  - Suggests code improvements and best practices
- **Supports Multiple Languages**: Works with various programming languages
- **Focused Feedback**: Only reports issues with high confidence

## Review Workflow

All prompts used for AI analysis live under the `prompts/` directory. The app loads these templates at runtime and fills in variables such as the file name or manager instructions before sending them to the configured model. Editing the text files allows you to tweak the review style without changing code.

To customise the review behaviour for a repository, add a file named `AI_REVIEW_INSTRUCTIONS.md` to the repository root or within any folder. The contents of the closest instructions file are inserted into the review prompts for files in that directory. See `AI_REVIEW_INSTRUCTIONS_TEMPLATE.md` for an example template.

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
    - Pull request review comments: Read & Write
  - Under "Subscribe to events", select:
    - Pull request
    - Issue comment
    - Pull request review comment
    - Installation
   - Click "Create GitHub App"
   - Generate a private key and download it
   - Deploy your `gh-review` service and update the GitHub App's webhook URL
   - Use the generated webhook secret and credentials in your `.env` file

## Deployment

### Configure Environment Variables
   - Copy `.env.example` to `.env`
   - Fill in the values from your GitHub App settings
   - Set `APP_ID`, `PRIVATE_KEY`, and `WEBHOOK_SECRET` with the credentials from the app you created
   - For the private key, copy the contents of the downloaded `.pem` file and format it as a single line with `\n` for newlines
   - Set Google Cloud details with `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` (and optionally `GOOGLE_APPLICATION_CREDENTIALS`)
   - (Optional) Choose an AI provider with `LLM_PROVIDER` (`google`, `openai`, `anthropic`)
   - (Optional) Set `GENAI_MODEL`, `OPENAI_MODEL`, or `ANTHROPIC_MODEL` to override defaults
  - Provide API keys with `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` when using the
    corresponding provider
  - (Optional) Configure generation with `LLM_MAX_TOKENS`, `LLM_TEMPERATURE`,
    `LLM_TOP_P`, and `LLM_TOP_K`
  - (Optional) Set `PORT` for local testing (default `3000`)
   - (Optional) Tune limits with:
     - `MAX_FILES_TO_PROCESS` (default 20)
     - `MAX_DIFF_LENGTH`, `MAX_DIFF_LINES`, `MAX_FILE_SIZE`, and
       `MAX_CONTEXT_LINES`
     - `CONCURRENCY_LIMIT` (default 3)
     - `REQUEST_TIMEOUT` in milliseconds (default 30000)
   - (Optional) Control event triggers with:
     - `ENABLE_ISSUE_COMMENT_EVENT` (`true` by default)
     - `ENABLE_LABEL_EVENT` (`false` by default)
     - `TRIGGER_LABEL` (label name to trigger review, default `ai-review`)
     - `REVIEW_COMMENT_KEYWORD` (default `/review`)
     - `SUMMARY_COMMENT_KEYWORD` (default `/what`)
   - (Optional) Customize instructions with:
     - `ENABLE_REPO_INSTRUCTIONS` (`false` by default)
     - `INSTRUCTION_FILENAME` (file name containing instructions, default `AI_REVIEW_INSTRUCTIONS.md`)

### Deploy to Cloud Run

Run:
```bash
gcloud run deploy github-pr-reviewer --source . --region australia-southeast1
```
Ensure the container executes `npm start`.
Set the environment variables above in your Cloud Run configuration.

Local execution is mainly for running tests:
```bash
npm test
```

## Security

This app verifies every GitHub webhook using the `WEBHOOK_SECRET` you configure.
Only signed requests from GitHub are processed. The service also exchanges the
installation ID for a short-lived access token on each request so all GitHub API
calls are properly authenticated and scoped to your repository.

## Development

- The main application logic is in `index.js`
- The app listens for GitHub webhook events:
  - `issue_comment.created`
  - `pull_request_review_comment.created`
  - `pull_request.labeled`
  - `installation.created`
- Reviews are submitted using the GitHub API


## License

MIT
