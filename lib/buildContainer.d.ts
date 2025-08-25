export interface BuildResult {
    containerId: string;
    hostPort: number;
    imageName: string;
}
/**
 * Clone a GitHub repository to a temporary directory
 */
export declare function clonePRRepo(branch: string, repoURL: string, targetDir?: string): Promise<string>;
/**
 * Build a Docker image from the cloned repository path
 */
export declare function buildContainerFromPath(repoPath: string, prNumber: number, dockerfilePath?: string): Promise<BuildResult>;
/**
 * Ensure Docker is available and responding
 */
export declare function ensureDockerIsAvailable(): Promise<void>;
/**
 * Cleanup temporary directory (used after container is built)
 */
export declare function cleanupTempDir(dirPath: string): Promise<void>;
//# sourceMappingURL=buildContainer.d.ts.map