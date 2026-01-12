# Contributing to Odette

Thanks for your interest in contributing!

## Reporting Issues

- Check if the issue already exists
- Provide clear steps to reproduce bugs
- Include version numbers or git commit hashes, and environment details

## Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests: `npm test`
5. Ensure code follows existing style
6. Commit with clear messages
7. Push to your fork
8. Open a Pull Request

## Development Setup

```bash
npm install
npm test
npm run dev
```

See [README.md](README.md) for more details.

## Release Process

Releases are automated via GitHub Actions:

1. Update version in `package.json` (follow [semantic versioning](https://semver.org/))
2. Commit the version change
3. Create and push a git tag:
   ```bash
   git tag -a v0.2.0 -m "Release v0.2.0"
   git push origin v0.2.0
   ```
4. GitHub Actions will automatically:
   - Run tests
   - Build the application
   - Create a GitHub release with build artifacts
   - Build and push Docker images to `ghcr.io/cdanis/odette`
   - Tag Docker images with the version number (and `latest` for stable releases only)

Release artifacts include a compressed tarball with the built application files.

## Code Style

- Use TypeScript
- Err towards being minimal
- Follow existing patterns in the codebase
- Add tests for new features
- Update documentation as needed

## License

By contributing, you agree that your contributions will be licensed under the AGPL-3.0 license.
