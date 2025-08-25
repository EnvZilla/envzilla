export interface DestroyResult {
    success: boolean;
    containerId: string;
    containerDestroyed: boolean;
    imageDestroyed: boolean;
    errors: string[];
}
/**
 * Destroy a container and optionally its associated image
 */
export declare function destroyContainer(containerId: string, prNumber?: number, options?: {
    destroyImage?: boolean;
    containerName?: string;
}): Promise<DestroyResult>;
/**
 * Find and destroy containers by PR number
 */
export declare function destroyByPRNumber(prNumber: number): Promise<DestroyResult[]>;
/**
 * List all preview containers
 */
export declare function listPreviewContainers(): Promise<Array<{
    id: string;
    name: string;
    status: string;
    image: string;
}>>;
//# sourceMappingURL=destroyContainer.d.ts.map