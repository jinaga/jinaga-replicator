# jinaga-replicator

The Jinaga Replicator is a single machine in a network.
It stores and shares facts.
To get started, create a Replicator of your very own using [Docker](https://www.docker.com/products/docker-desktop/).

```
docker pull jinaga/jinaga-replicator
docker run --name my-replicator -p8080:8080 jinaga/jinaga-replicator
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

## Build and Run

Build:

```bash
docker build . -t jinaga/jinaga-replicator:latest
```

Run:

```bash
docker run -it --rm -p8080:8080 jinaga/jinaga-replicator
```

If you have policy files that you want to use with this image, you can mount a directory containing your policy files to the container's `/var/lib/replicator/policies` directory:

```bash
docker run -it --rm -p8080:8080 -v /path/to/your/policies:/var/lib/replicator/policies jinaga/jinaga-replicator
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

## Release

To release a new version of Jinaga replicator, bump the version number, push the tag, and let GitHub Actions do the rest.

```bash
git checkout main
git pull
npm version patch
git push --follow-tags
```