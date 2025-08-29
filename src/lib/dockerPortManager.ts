import Docker from 'dockerode';
import logger from '../utils/logger.js';

const docker = new Docker();

export interface PortMapping {
  containerPort: number;
  hostPort: number;
  hostIP?: string;
}

/**
 * Get container port mappings using Docker API instead of spawning docker port command
 */
export async function getContainerPortMappings(containerName: string): Promise<PortMapping[]> {
  try {
    const container = docker.getContainer(containerName);
    const inspectData = await container.inspect();
    
    const portMappings: PortMapping[] = [];
    const ports = inspectData.NetworkSettings.Ports;
    
    if (!ports) {
      throw new Error(`No port mappings found for container ${containerName}`);
    }
    
    for (const [containerPortProto, hostBindings] of Object.entries(ports)) {
      if (!hostBindings || !Array.isArray(hostBindings)) continue;
      
      const containerPort = parseInt(containerPortProto.split('/')[0]);
      
      for (const binding of hostBindings) {
        if (binding.HostPort) {
          portMappings.push({
            containerPort,
            hostPort: parseInt(binding.HostPort),
            hostIP: binding.HostIp
          });
        }
      }
    }
    
    if (portMappings.length === 0) {
      throw new Error(`No valid port mappings found for container ${containerName}`);
    }
    
    logger.debug({ containerName, portMappings }, 'Retrieved port mappings via Docker API');
    return portMappings;
    
  } catch (error) {
    logger.error({ err: error, containerName }, 'Failed to get port mappings via Docker API');
    throw error;
  }
}

/**
 * Get specific port mapping for a container's internal port
 */
export async function getHostPortForContainer(
  containerName: string, 
  containerPort: number
): Promise<number> {
  const mappings = await getContainerPortMappings(containerName);
  
  const mapping = mappings.find(m => m.containerPort === containerPort);
  if (!mapping) {
    throw new Error(`No mapping found for container port ${containerPort} in ${containerName}`);
  }
  
  return mapping.hostPort;
}

/**
 * Cache for port mappings to avoid repeated API calls
 */
class PortMappingCache {
  private cache = new Map<string, { mappings: PortMapping[]; timestamp: number }>();
  private readonly TTL = 30000; // 30 seconds cache TTL
  
  async getPortMappings(containerName: string): Promise<PortMapping[]> {
    const cached = this.cache.get(containerName);
    const now = Date.now();
    
    if (cached && (now - cached.timestamp) < this.TTL) {
      logger.debug({ containerName }, 'Using cached port mappings');
      return cached.mappings;
    }
    
    const mappings = await getContainerPortMappings(containerName);
    this.cache.set(containerName, { mappings, timestamp: now });
    
    // Cleanup old entries
    for (const [key, value] of this.cache.entries()) {
      if ((now - value.timestamp) > this.TTL * 2) {
        this.cache.delete(key);
      }
    }
    
    return mappings;
  }
  
  clear(containerName?: string): void {
    if (containerName) {
      this.cache.delete(containerName);
    } else {
      this.cache.clear();
    }
  }
}

export const portMappingCache = new PortMappingCache();
