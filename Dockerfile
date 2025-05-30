# ---- Builder Stage ----
# This stage installs dependencies, copies source code, and builds the TypeScript.
FROM node:22 AS builder
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (or yarn.lock)
COPY package.json package-lock.json ./

RUN npm ci

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
FROM node:22-slim
WORKDIR /usr/src/app

# Set Node environment to production
ENV NODE_ENV production

# Create a non-root user and group for security
#RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy production node_modules from the builder stage
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Copy the compiled application code from the builder stage
COPY --from=builder /usr/src/app/dist ./dist

# Copy views and public directories (needed at runtime)
COPY --from=builder /usr/src/app/views ./views
COPY --from=builder /usr/src/app/public ./public

# Copy package.json (optional, but can be useful for runtime info or some tools)
COPY --from=builder /usr/src/app/package.json ./package.json

# Create a directory for persistent data (like SQLite database) and set ownership
# The actual database file should be mounted as a volume to /data/rsvp.sqlite
# The banner images will be stored in a subdirectory of /data as well.
RUN mkdir /data

# Switch to the non-root user
#USER appuser

# Expose the port the app runs on
# Your app uses process.env.PORT || '3000'
EXPOSE 3000

# Set default paths, can be overridden by environment variables at runtime
ENV DB_PATH /data/rsvp.sqlite
ENV EVENT_BANNER_STORAGE_PATH /data/uploads/event-banners

# Command to run the application (updated to dist/main.js)
CMD ["node", "dist/main.js"]
