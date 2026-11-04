export function backupEnvironment(password: string): Record<string, string> {
  if (!password) throw new Error("Backup repository password is missing");
  return {
    RESTIC_REPOSITORY: "rest:http://kitties-backups.internal/",
    RESTIC_PASSWORD: password,
    RESTIC_CACHE_DIR: "/tmp/restic-cache",
  };
}
