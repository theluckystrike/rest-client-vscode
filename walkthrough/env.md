# Environments

Put a file named `http-client.env.json` next to your .http files:

```json
{
  "$shared": { "contentType": "application/json" },
  "dev":  { "baseUrl": "http://localhost:3000", "token": "dev-token" },
  "prod": { "baseUrl": "https://api.example.com", "token": "" }
}
```

Then write `GET {{baseUrl}}/users` and pick the environment with Switch Environment (Ctrl+Alt+E). Values in `$shared` apply to every environment. Keep secrets in `http-client.private.env.json` and add that file to `.gitignore`. `{{$dotenv NAME}}` reads a `.env` file and `{{$processEnv NAME}}` reads an environment variable.
