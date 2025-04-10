import { parseArgs } from "@std/cli/parse-args";
import { pooledMap } from "@std/async/pool";
import { exists } from "@std/fs/exists";
import { ensureDir } from "@std/fs/ensure-dir";
import { join } from "@std/path";

type DownloadStatus = "downloaded" | "skipped" | "failed";

export interface FigmaImageDownloaderOptions {
  token: string;
  fileKey: string;
  outputDir: string;
  concurrentDownloads?: number;
  apiBaseUrl?: string;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadProgress {
  totalTasks: number;
  completed: number;
  successful: number;
  skipped: number;
  failed: number;
  percentage: number;
}

export interface FigmaFileNode {
  name: string;
  fills?: { type: "IMAGE" | unknown; imageRef: string }[];
  children: FigmaFileNode[];
}

class FigmaAPI {
  constructor(
    private token: string,
    private baseUrl = "https://api.figma.com/v1",
  ) {}

  async fetch<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      headers: { "X-Figma-Token": this.token },
    });
    if (!response.ok) {
      throw new Error(
        `API Error (${response.status}): ${await response.text()}`,
      );
    }
    return response.json();
  }
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
};

const sanitizeName = (name: string): string => {
  return (
    (name || "untitled")
      .replace(/[/\\:*?"<>|]/g, "")
      .replace(/[\s._]{2,}/g, "_")
      .replace(/^[._\s]+|[._\s]+$/g, "")
      .trim()
      .substring(0, 100) || "untitled"
  );
};

const getExtension = (contentType: string): string => {
  return MIME_EXTENSIONS[contentType] || ".png";
};

export async function downloadFigmaImages(
  options: FigmaImageDownloaderOptions,
): Promise<DownloadProgress> {
  const api = new FigmaAPI(options.token, options.apiBaseUrl);
  const stats = { completed: 0, successful: 0, skipped: 0, failed: 0 };

  // Get file data and image URLs
  const [fileData, urlData] = await Promise.all([
    api.fetch<{ document: FigmaFileNode }>(`/files/${options.fileKey}`),
    api.fetch<{ meta: { images: Record<string, string> } }>(
      `/files/${options.fileKey}/images`,
    ),
  ]);

  // Process nodes recursively to find images
  const findImages = (
    node: FigmaFileNode,
    path: string[] = [],
  ): { ref: string; path: string[]; name: string }[] => {
    const currentPath = [...path, sanitizeName(node.name)];
    return [
      ...(node.fills
        ?.filter((f) => f.type === "IMAGE" && f.imageRef)
        .map((f) => ({
          ref: f.imageRef,
          path: currentPath,
          name: node.name,
        })) || []),
      ...(node.children?.flatMap((c) => findImages(c, currentPath)) || []),
    ];
  };

  // Create download tasks
  const tasks = findImages(fileData.document)
    .filter((img) => urlData.meta.images[img.ref])
    .map((img) => ({
      ref: img.ref,
      url: urlData.meta.images[img.ref],
      dir: join(options.outputDir, ...img.path.slice(0, -1)),
      filename: `${sanitizeName(img.name)}_${img.ref.slice(0, 8)}`,
    }));

  const doesImageExist = async (
    fullTargetPathWithoutExt: string,
  ): Promise<string | false> => {
    for (const ext of Object.values(MIME_EXTENSIONS)) {
      if (await exists(fullTargetPathWithoutExt + ext, { isFile: true })) {
        return fullTargetPathWithoutExt + ext;
      }
    }
    return false;
  };

  // Download function
  const download = async (task: (typeof tasks)[0]): Promise<DownloadStatus> => {
    try {
      if (await doesImageExist(join(task.dir, task.filename))) return "skipped";

      const response = await fetch(task.url);
      if (!response.ok) return "failed";

      const ext = getExtension(response.headers.get("content-type") || "");
      const fullPath = join(task.dir, `${task.filename}${ext}`);

      await ensureDir(task.dir);
      await Deno.writeFile(
        fullPath,
        new Uint8Array(await response.arrayBuffer()),
      );
      return "downloaded";
    } catch {
      return "failed";
    }
  };

  // Process downloads
  const results = pooledMap(
    options.concurrentDownloads || 10,
    tasks,
    async (task) => {
      console.log(task);
      const status = await download(task);
      console.log("end", status, task.ref);
      stats[status === "downloaded" ? "successful" : status]++;
      stats.completed++;

      options.onProgress?.({
        ...stats,
        totalTasks: tasks.length,
        percentage: (stats.completed / tasks.length) * 100,
      });

      return status;
    },
  );

  await Array.fromAsync(results);

  return {
    ...stats,
    totalTasks: tasks.length,
    percentage: 100,
  };
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["file-key", "o"],
    alias: { o: "output" },
    default: { o: join("dist", "images") },
  });

  const result = await downloadFigmaImages({
    token: Deno.env.get("FIGMA_API_TOKEN") as string,
    fileKey: args["file-key"] as string,
    outputDir: args.output,
    onProgress: (p) => console.log(`${p.percentage}% complete`),
  });

  console.log(result);
}
