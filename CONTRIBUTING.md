# Contributing to Meridian

## Setup

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/Meridian.git`
3. Install dependencies: `npm install`
4. Build the project: `npm run build`
5. Run tests: `npm test`

## Branching

- `main`: Production-ready code
- `develop`: Integration branch for features
- Feature branches: `feature/description`
- Bug fixes: `fix/description`
- Documentation: `docs/description`

Create feature branches from `develop`. Submit pull requests targeting `develop`.

## Commit Messages

Follow conventional commits:

- `feat: add Stripe provider adapter`
- `fix: correct rate limit header parsing`
- `docs: update API documentation`
- `test: add circuit breaker state transition tests`
- `refactor: simplify pagination strategy interface`

Scope is optional but recommended: `feat(github): add OAuth2 support`

## Testing

All new code must include tests:

- Unit tests for isolated components
- Integration tests for provider adapters
- Edge case coverage for resilience patterns

Run `npm test` before submitting. Ensure all tests pass and coverage does not decrease.

## Pull Request Process

1. Update CHANGELOG.md with your changes
2. Ensure all tests pass
3. Update documentation if API changes
4. Request review from maintainers
5. Address feedback and maintain discussion thread

PRs are merged after:
- At least one maintainer approval
- All CI checks passing
- No merge conflicts
- Documentation updated if needed

## Code Style

- TypeScript strict mode
- Biome for formatting and linting
- No `any` types in public API
- Prefer explicit types over inference in public interfaces

Run `npm run lint` before committing.


