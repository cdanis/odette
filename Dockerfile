# ---- Builder Stage ----
# This stage installs dependencies, copies source code, and builds the TypeScript.
FROM node:20-alpine AS builder
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (or yarn.lock)
COPY package.json package-lock.json ./

# Install only production dependencies.
RUN npm ci --omit=dev

# Copy the rest of the application source code needed for the build
COPY src ./src
COPY public ./public
COPY views ./views
COPY tsconfig.json ./tsconfig.json

# Run the build script (e.g., tsc)
RUN npm run build
# At this point, ./dist should contain the compiled JavaScript (e.g. dist/main.js)

# ---- Production Stage ----
# This stage creates the final lean image with only runtime necessities.
FROM node:20-alpine
WORKDIR /usr/src/app

# Set Node environment to production
ENV NODE_ENV production

# Create a non-root user and group for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy production node_modules from the builder stage
COPY --from=builder --chown=appuser:appgroup /usr/src/app/node_modules ./node_modules

# Copy the compiled application code from the builder stage
COPY --from=builder --chown=appuser:appgroup /usr/src/app/dist ./dist

# Copy views and public directories (needed at runtime)
COPY --from=builder --chown=appuser:appgroup /usr/src/app/views ./views
COPY --from=builder --chown=appuser:appgroup /usr/src/app/public ./public

# Copy package.json (optional, but can be useful for runtime info or some tools)
COPY --from=builder --chown=appuser:appgroup /usr/src/app/package.json ./package.json

# Create a directory for persistent data (like SQLite database) and set ownership
# The actual database file should be mounted as a volume to /data/rsvp.sqlite
RUN mkdir /data && chown appuser:appgroup /data

# Switch to the non-root user
USER appuser

# Expose the port the app runs on
# Your app uses process.env.PORT || '3000'
EXPOSE 3000

# Set a default path for the database, can be overridden by DB_PATH env var at runtime
ENV DB_PATH /data/rsvp.sqlite

# Command to run the application (updated to dist/main.js)
CMD ["node", "dist/main.js"]
