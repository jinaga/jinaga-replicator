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
