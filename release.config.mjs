export default {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/npm",
      {
        npmPublish: false,
        tarballDir: "release",
      },
    ],
    [
      "@semantic-release/github",
      {
        assets: [
          {
            path: "release/*.tgz",
            label: "npm package tarball",
          },
        ],
      },
    ],
  ],
};
