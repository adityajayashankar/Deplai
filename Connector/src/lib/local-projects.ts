import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

const LOCAL_PROJECTS_BASE = path.join(process.cwd(), 'tmp', 'local-projects');

function ensureBaseDirectory() {
  if (!fs.existsSync(LOCAL_PROJECTS_BASE)) {
    fs.mkdirSync(LOCAL_PROJECTS_BASE, { recursive: true });
  }
}

export function getProjectPath(userId: string, projectId: string): string {
  return path.join(LOCAL_PROJECTS_BASE, userId, projectId);
}

export function getZipPath(userId: string, projectId: string): string {
  return path.join(LOCAL_PROJECTS_BASE, userId, `${projectId}.zip`);
}

/** Prevent directory traversal attacks */
function validatePath(projectPath: string, requestedPath: string): string {
  const fullPath = path.join(projectPath, requestedPath);
  const normalizedPath = path.normalize(fullPath);

  if (!normalizedPath.startsWith(projectPath)) {
    throw new Error('Invalid path: directory traversal detected');
  }
  
  return normalizedPath;
}

function getDirectoryStats(dirPath: string): { size: number; fileCount: number } {
  let totalSize = 0;
  let fileCount = 0;

  function traverse(currentPath: string) {
    const items = fs.readdirSync(currentPath, { withFileTypes: true });
    
    for (const item of items) {
      const fullPath = path.join(currentPath, item.name);
      
      if (item.isDirectory()) {
        traverse(fullPath);
      } else if (item.isFile()) {
        totalSize += fs.statSync(fullPath).size;
        fileCount++;
      }
    }
  }

  traverse(dirPath);
  return { size: totalSize, fileCount };
}

export async function extractZipToProject(
  zipBuffer: Buffer,
  userId: string,
  projectId: string
): Promise<{ path: string; fileCount: number; sizeBytes: number }> {
  ensureBaseDirectory();
  
  const projectPath = getProjectPath(userId, projectId);

  if (fs.existsSync(projectPath)) {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
  fs.mkdirSync(projectPath, { recursive: true });

  try {
    // Save the original zip file
    const zipFilePath = getZipPath(userId, projectId);
    fs.writeFileSync(zipFilePath, zipBuffer);

    // Extract zip
    const zip = new AdmZip(zipBuffer);
    const zipEntries = zip.getEntries();
    
    // Find the root directory (if zip has a single root folder)
    let rootFolder: string | null = null;
    const topLevelItems = new Set<string>();
    
    for (const entry of zipEntries) {
      const parts = entry.entryName.split('/');
      if (parts.length > 0 && parts[0]) {
        topLevelItems.add(parts[0]);
      }
    }
    
    // If all files are in a single folder, use that as root
    if (topLevelItems.size === 1) {
      rootFolder = Array.from(topLevelItems)[0];
    }

    // Extract files
    for (const entry of zipEntries) {
      if (entry.isDirectory) continue;
      
      let relativePath = entry.entryName;
      
      // Strip root folder if it exists
      if (rootFolder && relativePath.startsWith(rootFolder + '/')) {
        relativePath = relativePath.substring(rootFolder.length + 1);
      }
      
      // Skip hidden files and common build directories
      if (shouldSkipFile(relativePath)) {
        continue;
      }
      
      const targetPath = path.join(projectPath, relativePath);
      const targetDir = path.dirname(targetPath);
      
      // Create directory structure
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      
      // Write file
      fs.writeFileSync(targetPath, entry.getData());
    }

    // Calculate stats
    const stats = getDirectoryStats(projectPath);
    
    return {
      path: path.join(userId, projectId),
      fileCount: stats.fileCount,
      sizeBytes: stats.size,
    };
  } catch (error: any) {
    // Cleanup on error
    if (fs.existsSync(projectPath)) {
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
    const zipFilePath = getZipPath(userId, projectId);
    if (fs.existsSync(zipFilePath)) {
      fs.rmSync(zipFilePath, { force: true });
    }
    throw new Error(`Failed to extract zip: ${error.message}`);
  }
}

export function deleteProject(userId: string, projectId: string): void {
  const projectPath = getProjectPath(userId, projectId);

  if (fs.existsSync(projectPath)) {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }

  // Delete the stored zip file
  const zipFilePath = getZipPath(userId, projectId);
  if (fs.existsSync(zipFilePath)) {
    fs.rmSync(zipFilePath, { force: true });
  }

  const userDir = path.join(LOCAL_PROJECTS_BASE, userId);
  if (fs.existsSync(userDir) && fs.readdirSync(userDir).length === 0) {
    fs.rmSync(userDir, { recursive: true, force: true });
  }
}

export function getDirectoryContents(
  userId: string,
  projectId: string,
  dirPath: string = ''
): Array<{ name: string; path: string; type: 'dir' | 'file'; size: number | null }> {
  const projectPath = getProjectPath(userId, projectId);
  const fullPath = validatePath(projectPath, dirPath);

  if (!fs.existsSync(fullPath)) {
    throw new Error('Path does not exist');
  }

  const items = fs.readdirSync(fullPath, { withFileTypes: true });

  return items
    .filter(item => !item.name.startsWith('.'))
    .map(item => {
      const itemPath = path.join(dirPath, item.name).replace(/\\/g, '/');
      const itemFullPath = path.join(fullPath, item.name);

      return {
        name: item.name,
        path: itemPath,
        type: item.isDirectory() ? 'dir' as const : 'file' as const,
        size: item.isFile() ? fs.statSync(itemFullPath).size : null,
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'dir' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
}

export function getFileContents(
  userId: string,
  projectId: string,
  filePath: string
): string {
  const projectPath = getProjectPath(userId, projectId);
  const fullPath = validatePath(projectPath, filePath);

  if (!fs.existsSync(fullPath)) {
    throw new Error('File does not exist');
  }

  if (fs.statSync(fullPath).isDirectory()) {
    throw new Error('Path is a directory, not a file');
  }

  return fs.readFileSync(fullPath, 'utf-8');
}

const SKIP_PATTERNS = [
  /^\./, /\/\./,
  /node_modules/, /\.git\//, /dist\//, /build\//, /\.next\//,
  /coverage\//, /__pycache__\//, /\.pytest_cache\//, /\.venv\//, /venv\//,
  /\.vscode\//, /\.idea\//,
  /\.DS_Store/, /Thumbs\.db/,
];

function shouldSkipFile(filePath: string): boolean {
  return SKIP_PATTERNS.some(pattern => pattern.test(filePath));
}