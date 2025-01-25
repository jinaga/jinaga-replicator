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

To use authentication, mount a directory containing your authentication provider files to the container's `/var/lib/replicator/authentication` directory:

```bash
docker run -d --name my-replicator -p8080:8080 -v /path/to/your/authentication:/var/lib/replicator/authentication jinaga/jinaga-replicator
```

Replace `/path/to/your/authentication` with the path to the directory on your host machine that contains your authentication provider files.

### JSON Provider File Specification

Each JSON provider file should have the following structure:

```json
{
    "provider": "string",
    "issuer": "string",
    "audience": "string",
    "key_id": "string",
    "key": "string"
}
```

- `provider`: A unique identifier for the authentication provider.
- `issuer`: The expected issuer (`iss`) claim in the JWT.
- `audience`: The expected audience (`aud`) claim in the JWT.
- `key_id`: The key identifier (`kid`) used to select the key for verifying the JWT signature.
- `key`: The key used to verify the JWT signature. This can be a PEM-encoded public key for asymmetric algorithms, or a shared key for symmetric algorithms.

### Example

Here is an example of an authentication provider file using RSA validation:

```json
{
    "provider": "example-rsa",
    "issuer": "https://example.com",
    "audience": "my-replicator",
    "key_id": "WVoKvLhSUl8cJRNGo6pKUUvia8Q",
	"key": "-----BEGIN PUBLIC KEY-----\nMIIBI...DAQAB\n-----END PUBLIC KEY-----"
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

To run a replicator with security policies, mount a directory containing your policy files to the container's `/var/lib/replicator/policies` directory:

```bash
docker run -d --name my-replicator -p8080:8080 -v /path/to/your/policies:/var/lib/replicator/policies jinaga/jinaga-replicator
```

Replace `/path/to/your/policies` with the path to the directory on your host machine that contains your policy files.

### Using as a Base Image

To use this image as a base image and copy your policy files into the `/var/lib/replicator/policies` directory, create a `Dockerfile` like this:

```dockerfile
FROM jinaga/jinaga-replicator

# Copy policy files into the /var/lib/replicator/policies directory
COPY *.policy /var/lib/replicator/policies/

# Ensure the policy files have the correct permissions
RUN chmod -R 755 /var/lib/replicator/policies
```

Build the new Docker image:

```bash
docker build -t my-replicator-with-policies .
```

This will create a new Docker image named `my-replicator-with-policies` with the policy files included.

### No Security Policies

To run a replicator with no security policies, create an empty `no-security-policies` file in the policy directory.

```bash
touch /var/lib/replicator/policies/no-security-policies
```

This file opts-in to running the replicator with no security policies.
If the file is not present, the replicator will exit with an error message indicating that no security policies are found.

The image `jinaga/jinaga-replicator-no-security-policies` is a variant of the Jinaga Replicator image that does not run any security policies.
It includes a `no-security-policies` file in the `/var/lib/replicator/policies` directory.

## Subscription Files

Subscription files define the facts that a client is interested in receiving updates for. These files are used to configure the replicator to push updates to connected clients.

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

To run a replicator with subscription files, mount a directory containing your subscription files to the container's `/var/lib/replicator/subscriptions` directory:

```bash
docker run -d --name my-replicator -p8080:8080 -v /path/to/your/subscriptions:/var/lib/replicator/subscriptions jinaga/jinaga-replicator
```

Replace `/path/to/your/subscriptions` with the path to the directory on your host machine that contains your subscription files.

### Using as a Base Image

To use this image as a base image and copy your subscription files into the `/var/lib/replicator/subscriptions` directory, create a `Dockerfile` like this:

```dockerfile
FROM jinaga/jinaga-replicator

# Copy subscription files into the /var/lib/replicator/subscriptions directory
COPY *.subscription /var/lib/replicator/subscriptions/

# Ensure the subscription files have the correct permissions
RUN chmod -R 755 /var/lib/replicator/subscriptions
```

Build the new Docker image:

```bash
docker build -t my-replicator-with-subscriptions .
```

This will create a new Docker image named `my-replicator-with-subscriptions` with the subscription files included.

## Configuration

The Jinaga Replicator can be configured using environment variables. Below are the available configuration options:

### Environment Variables

- `REPLICATOR_PORT`: The port on which the replicator will listen. Default is `8080`.
- `REPLICATOR_LOG_LEVEL`: The log level for the replicator. Options are `debug`, `info`, `warn`, `error`. Default is `info`.
- `REPLICATOR_DATA_PATH`: The path to the directory where the replicator will store its data. Default is `/var/lib/replicator/data`.
- `REPLICATOR_AUTH_PATH`: The path to the directory where the replicator will look for authentication provider files. Default is `/var/lib/replicator/authentication`.
- `REPLICATOR_POLICY_PATH`: The path to the directory where the replicator will look for policy files. Default is `/var/lib/replicator/policies`.

### Example Configuration

To run a replicator with custom configuration:

```bash
docker run -d --name my-replicator \
  -p 9090:9090 \
  -e REPLICATOR_PORT=9090 \
  -e REPLICATOR_LOG_LEVEL=debug \
  -e REPLICATOR_DATA_PATH=/custom/data/path \
  -e REPLICATOR_AUTH_PATH=/custom/auth/path \
  -e REPLICATOR_POLICY_PATH=/custom/policy/path \
  jinaga/jinaga-replicator
```

This will start a replicator on port 9090 with debug logging, storing data, authentication, and policy files in custom paths.

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

### Behavior

1. The container will scan for all environment variables matching the `REPLICATOR_UPSTREAM_<N>` pattern, starting from `REPLICATOR_UPSTREAM_1`.
2. It will continue until it encounters a gap in the numbering (e.g., `REPLICATOR_UPSTREAM_1` and `REPLICATOR_UPSTREAM_3` are set, but `REPLICATOR_UPSTREAM_2` is missing). At this point, no further upstreams will be considered.
3. Any invalid URLs or skipped numbers in the sequence will result in a warning being logged, and those entries will be ignored.

### Validation Rules

- **Base URL validation:** The value must be a syntactically valid base URL with a scheme of `http` or `https`. The absence of a valid scheme will cause the entry to be ignored.
- **Sequential numbering:** Variables must be sequentially numbered, starting from `REPLICATOR_UPSTREAM_1`. Non-sequential numbering will cause later variables to be ignored.

### Logging and Debugging

On startup, the container will log the list of upstream replicators it has detected.
Example:
```plaintext
Detected upstream replicators:
1. https://replicator1.example.com
2. https://replicator2.example.com
```

### Use Cases

- **Static Configuration:** Specify upstreams directly when running the container:
  ```shell
  docker run \
    -e REPLICATOR_UPSTREAM_1=http://replicator1.local \
    -e REPLICATOR_UPSTREAM_2=https://replicator2.cloud \
    jinaga/jinaga-replicator
  ```
- **Dynamic Configuration:** Use container orchestration tools like Kubernetes to dynamically inject environment variables for upstream replicators.

This approach provides flexibility for users to define multiple upstreams while maintaining clarity and simplicity in the configuration.

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
