# Jinaga Replicator

The Jinaga Replicator is the central infrastructure component of a Jinaga network.
It plays the role of:
- Database
- REST API
- Message queue
- WebSocket server

Connect your application to the Replicator to store and share facts.
Connect replicators to one another to share facts across a network.

To get started, create a Replicator of your very own using [Docker](https://www.docker.com/products/docker-desktop/).
To experiment, you will want to run a Replicator with no security policies.

```
docker pull jinaga/jinaga-replicator-no-security-policies
docker run -d --name my-replicator -p8080:8080 jinaga/jinaga-replicator-no-security-policies
```

This creates and starts a new container called `my-replicator`.
The container is listening at port 8080 for commands.
Use a tool like [Postman](https://www.postman.com/) to `POST` messages to `http://localhost:8080/jinaga/write` and `/read`.
Or configure a Jinaga client to connect to the Replicator.

```typescript
import { JinagaBrowser } from "jinaga";

export const j = JinagaBrowser.create({
    httpEndpoint: "http://localhost:8080/jinaga"
});
```

Learn more at [jinaga.com](https://jinaga.com/documents/replicator/).

## Authentication

The Jinaga Replicator supports authentication using JSON Web Tokens (JWT).
You can configure authentication providers by placing JSON files in the authentication folder.

### Authentication Folder

To use authentication, mount a directory containing your authentication provider files to the container's `/var/lib/replicator/authentication` directory as read-only:

```bash
docker run -d --name my-replicator -p8080:8080 -v /path/to/your/authentication:/var/lib/replicator/authentication:ro jinaga/jinaga-replicator
```

Replace `/path/to/your/authentication` with the path to the directory on your host machine that contains your authentication provider files with a `.provider` extension.

### JSON Provider File Specification

A provider can resolve signing keys in one of two mutually exclusive ways:

1. **Static key** — pin a single key with `key_id` and `key`. Best for offline or symmetric (shared-secret) setups.
2. **JWKS endpoint** — declare a `jwks_uri` and the replicator resolves the signing key dynamically by the token's `kid` against the issuer's JWKS document (e.g. `.well-known/jwks.json`). Keys are cached and re-fetched on a cache miss, so issuer key rotation (including KMS-backed rotation) is picked up automatically without regenerating the file.

A provider file must use exactly one of these modes. Specifying `jwks_uri` together with `key` or `key_id` is rejected at startup.

A **static key** provider has this shape:

```json
{
    "provider": "string",
    "issuer": "string",
    "audience": "string",
    "key_id": "string",
    "key": "string"
}
```

A **JWKS endpoint** provider has this shape:

```json
{
    "provider": "string",
    "issuer": "string",
    "audience": "string",
    "jwks_uri": "string"
}
```

- `provider`: A unique identifier for the authentication provider.
- `issuer`: The expected issuer (`iss`) claim in the JWT.
- `audience`: The expected audience (`aud`) claim in the JWT.
- `key_id` *(static mode)*: The key identifier (`kid`) used to select the key for verifying the JWT signature.
- `key` *(static mode)*: The key used to verify the JWT signature. This can be a PEM-encoded public key for asymmetric algorithms, or a shared key for symmetric algorithms.
- `jwks_uri` *(JWKS mode)*: The HTTP(S) URL of the issuer's JWKS document. The signing key is selected by the token's `kid`.

The replicator enforces an explicit algorithm allowlist when verifying signatures (defense-in-depth against algorithm-confusion attacks): PEM public keys and JWKS-resolved keys are restricted to `RS256`, while static symmetric keys permit the HMAC family (`HS256`, `HS384`, `HS512`).

### Examples

An authentication provider using a static RSA public key:

```json
{
    "provider": "example-rsa",
    "issuer": "https://example.com",
    "audience": "my-replicator",
    "key_id": "WVoKvLhSUl8cJRNGo6pKUUvia8Q",
	"key": "-----BEGIN PUBLIC KEY-----\nMIIBI...DAQAB\n-----END PUBLIC KEY-----"
}
```

An authentication provider that resolves keys from a JWKS endpoint (supports RS256 key rotation):

```json
{
    "provider": "example-jwks",
    "issuer": "https://example.com",
    "audience": "my-replicator",
    "jwks_uri": "https://example.com/.well-known/jwks.json"
}
```

### Allow Anonymous Access

To allow anonymous access, create an empty `allow-anonymous` file in the authentication directory.

```bash
touch /var/lib/replicator/authentication/allow-anonymous
```

A user will be permitted to access the replicator without a bearer token if the `allow-anonymous` file is present. Authorization and distribution rules will still apply. The user will only be able to write facts with the `any` authorization rule, and can only read feeds shared with `everyone`.

## Security Policies

Policies determine who is authorized to write facts, and to whom to distribute facts.
They also determine the conditions under which to purge facts.
Authorization, distribution, and purge rules are defined in policy files.

### Policy Files

Policy files have three sections:

- **authorization**: Who is authorized to write facts.
- **distribution**: To whom to distribute facts.
- **purge**: Conditions under which to purge facts.

Here is an example policy file:

```
authorization {
    (post: Blog.Post) {
        creator: Jinaga.User [
            creator = post->site: Blog.Site->creator: Jinaga.User
        ]
    } => creator
    (deleted: Blog.Post.Deleted) {
        creator: Jinaga.User [
            creator = deleted->post: Blog.Post->site: Blog.Site->creator: Jinaga.User
        ]
    } => creator
}
distribution {
    share (user: Jinaga.User) {
        name: Blog.User.Name [
            name->user: Jinaga.User = user
            !E {
                next: Blog.User.Name [
                    next->prior: Blog.User.Name = name
                ]
            }
        ]
    } => name
    with (user: Jinaga.User) {
        self: Jinaga.User [
            self = user
        ]
    } => self
}
purge {
    (post: Blog.Post) {
        deleted: Blog.Post.Deleted [
            deleted->post: Blog.Post = post
        ]
    } => deleted
}
```

You can produce a policy file from .NET using the `dotnet jinaga` command line tool, or from JavaScript using the `jinaga` package.

### Mounting Policy Files

To run a replicator with security policies, mount a directory containing your policy files to the container's `/var/lib/replicator/policies` directory as read-only:

```bash
docker run -d --name my-replicator -p8080:8080 -v /path/to/your/policies:/var/lib/replicator/policies:ro jinaga/jinaga-replicator
```

Replace `/path/to/your/policies` with the path to the directory on your host machine that contains your policy files.

### No Security Policies

To run a replicator with no security policies, create an empty `no-security-policies` file in the policy directory.

```bash
touch /var/lib/replicator/policies/no-security-policies
```

This file opts-in to running the replicator with no security policies.
If the file is not present, the replicator will exit with an error message indicating that no security policies are found.

The image `jinaga/jinaga-replicator-no-security-policies` is a variant of the Jinaga Replicator image that does not run any security policies.
It includes a `no-security-policies` file in the `/var/lib/replicator/policies` directory.

## Upstream Replicators

The Jinaga Replicator can be configured to connect to upstream replicators using environment variables. Each upstream replicator's base URL is specified using a numbered environment variable.

### Environment Variable Naming Convention

Each environment variable must follow the format:
`REPLICATOR_UPSTREAM_<N>`
where `<N>` is a positive integer starting from 1, representing the order of the upstream replicator in the list.

### Value Format

The value of each environment variable must be a valid base URL, using either the `http` or `https` scheme.
Examples:
`http://replicator1.example.com`
`https://replicator2.example.com`

### Example Configuration

To configure a container with two upstream replicators:

```shell
docker run \
  -e REPLICATOR_UPSTREAM_1=https://replicator1.example.com \
  -e REPLICATOR_UPSTREAM_2=https://replicator2.example.com \
  jinaga/jinaga-replicator
```

## Subscription Files

Subscription files define the facts that a client is interested in receiving updates for. These files are used to configure the replicator to subscribe for updates from upstream replicators.

### Subscription File Structure

Each subscription file should have the following structure:

```
subscription {
    let variable: Fact.Type = {
        // Initial fact details
    }

    (variable: Fact.Type) {
        // Specification details
    }
}
```

### Example

Here is an example of a subscription file:

```
subscription {
    let creator: Jinaga.User = {
        publicKey: "--- FAKE PUBLIC KEY ---"
    }

    (creator: Jinaga.User) {
        site: Blog.Site [
            site->creator: Jinaga.User = creator
        ]
    }
}
```

### Mounting Subscription Files

To run a replicator with subscription files, mount a directory containing your subscription files to the container's `/var/lib/replicator/subscriptions` directory as read-only:

```bash
docker run -d --name my-replicator -p8080:8080 -v /path/to/your/subscriptions:/var/lib/replicator/subscriptions:ro jinaga/jinaga-replicator
```

Replace `/path/to/your/subscriptions` with the path to the directory on your host machine that contains your subscription files.

## Configuration

The Jinaga Replicator can be configured using environment variables. Below are the available configuration options:

### Environment Variables

- `PORT`: The port on which the replicator will listen. Default is `8080`.
- `JINAGA_POSTGRESQL`: The PostgreSQL connection string. Default is `postgresql://repl:replpw@localhost:5432/replicator`.
- `JINAGA_POLICIES`: The path to the directory where the replicator will look for policy files. Default is `policies`.
- `JINAGA_POLICIES_WATCH`: Set to `true` to hot-reload policy files. When enabled, the replicator watches the `JINAGA_POLICIES` directory and rebuilds its rules whenever a `.policy` file is added, changed, or removed — no restart required. Subsequent requests enforce the new rules while in-flight requests finish against the old ones. If a changed file fails to parse, the currently loaded rules are kept and the error is logged. Default is `false`.
- `JINAGA_AUTHENTICATION`: The path to the directory where the replicator will look for authentication provider files. Default is `authentication`.
- `JINAGA_SUBSCRIPTIONS`: The path to the directory where the replicator will look for subscription files. Default is `subscriptions`.
- `OTEL_EXPORTER_OTLP_ENDPOINT`: The OpenTelemetry OTLP endpoint accepting gRPC. If not set, OpenTelemetry will not be enabled.
- `OTEL_SERVICE_NAME`: The OpenTelemetry service name. Default is `jinaga-replicator`.

### Example Configuration

To run a replicator with custom configuration:

```bash
docker run -d --name my-replicator \
  -p 9090:9090 \
  -e PORT=9090 \
  -e JINAGA_POSTGRESQL=postgresql://custom:custompw@localhost:5432/customdb \
  -e JINAGA_POLICIES=/custom/policies/path \
  -e JINAGA_AUTHENTICATION=/custom/auth/path \
  -e JINAGA_SUBSCRIPTIONS=/custom/subscriptions/path \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317 \
  -e OTEL_SERVICE_NAME=my-replicator \
  -v /path/to/your/policies:/custom/policies/path:ro \
  -v /path/to/your/authentication:/custom/auth/path:ro \
  -v /path/to/your/subscriptions:/custom/subscriptions/path:ro \
  jinaga/jinaga-replicator
```

This will start a replicator on port 9090 with custom PostgreSQL connection string, and custom paths for policies, authentication, and subscription files. It will mount the respective directories from the host machine. OpenTelemetry will be enabled with the specified OTLP endpoint.

## Using as a Base Image

To use this image as a base image and copy your policy, subscription, and authentication files into the respective directories, create a `Dockerfile` like this:

```dockerfile
FROM jinaga/jinaga-replicator

# Copy policy files into the /var/lib/replicator/policies directory
COPY *.policy /var/lib/replicator/policies/

# Copy subscription files into the /var/lib/replicator/subscriptions directory
COPY *.subscription /var/lib/replicator/subscriptions/

# Copy authentication files into the /var/lib/replicator/authentication directory
COPY *.provider /var/lib/replicator/authentication/

# Ensure the files have the correct permissions
RUN chmod -R 755 /var/lib/replicator/policies /var/lib/replicator/subscriptions /var/lib/replicator/authentication
```

Build the new Docker image:

```bash
docker build -t my-replicator-with-config .
```

This will create a new Docker image named `my-replicator-with-config` with the policy, subscription, and authentication files included.

You may choose to embed some configuration files into the image, and mount others from a host folder. For example, it may be useful to build an image containing the policy and subscription files, while mounting the authentication folder so that keys can be easily rotated.

To embed some files while mounting others of the same type, mount a child folder. For example, you may wish to embed some common policy files into your image, and then mount a host volume for custom policies. Mount the custom policy folder as a child of the parent that contains the common files.

## Build and Run

Build:

```bash
docker build . -t jinaga/jinaga-replicator:latest
```

Run:

```bash
docker run -d --name my-replicator -p8080:8080 jinaga/jinaga-replicator
```

## Release

To release a new version of Jinaga replicator, bump the version number, push the tag, and let GitHub Actions do the rest.

```bash
git checkout main
git pull
npm version patch
git push --follow-tags
```
