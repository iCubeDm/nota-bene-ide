FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/nb-relay ./cmd/nb-relay
# distroless has no shell: create the certificate cache here, owned by nonroot.
RUN mkdir /out/cache

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/nb-relay /nb-relay
COPY --from=build --chown=65532:65532 /out/cache /cache
VOLUME /cache
EXPOSE 8080 8443
ENTRYPOINT ["/nb-relay","-cache","/cache","-https",":8443","-http",":8080"]
