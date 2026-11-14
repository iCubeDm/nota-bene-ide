# Base images are referenced by tag. A publishing pipeline should pin them by
# digest (and refresh the pins deliberately).
FROM golang:1.27 AS build
# Set by buildx for the requested platform; plain docker build gets amd64.
ARG TARGETARCH=amd64
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/nb-relay ./cmd/nb-relay
# distroless has no shell: create the certificate cache and the members
# directory here, owned by nonroot.
RUN mkdir /out/cache /out/members

FROM gcr.io/distroless/static-debian12:nonroot
# The hub's data budget is 256 MiB; this keeps the Go heap in check above it.
ENV GOMEMLIMIT=400MiB
COPY --from=build /out/nb-relay /nb-relay
COPY --from=build --chown=65532:65532 /out/cache /cache
COPY --from=build --chown=65532:65532 /out/members /members
VOLUME /cache /members
EXPOSE 8080 8443
ENTRYPOINT ["/nb-relay","-cache","/cache","-https",":8443","-http",":8080"]
