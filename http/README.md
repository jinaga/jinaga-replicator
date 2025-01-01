# Test Replicator with HTTP Files

Create a file named `.env.local` in this folder. Install the Visual Studio Code extension [HttpYac](https://marketplace.visualstudio.com/items?itemName=anweber.vscode-httpyac) to use the HTTP files. Use [FusionAuth](https://fusionauth.io/) to configure an OAuth2 provider.

```env
replicatorUrl=http://localhost:8080/jinaga

oauth2_authorizationEndpoint=http://localhost:9011/oauth2/authorize
oauth2_tokenEndpoint=http://localhost:9011/oauth2/token
oauth2_clientId=your-client-id
oauth2_usePkce=true
```