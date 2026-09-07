/** Artifact 正文的内容寻址存储端口；实现必须以 storageRef 幂等写入。 */
export interface ArtifactContentStore {
  put(storageRef: string, content: string): void;
  get(storageRef: string): string | undefined;
}

export class InMemoryArtifactContentStore implements ArtifactContentStore {
  private readonly values = new Map<string, string>();
  put(storageRef: string, content: string): void {
    const existing = this.values.get(storageRef);
    if (existing !== undefined && existing !== content) throw new Error(`content hash collision: ${storageRef}`);
    this.values.set(storageRef, content);
  }
  get(storageRef: string): string | undefined { return this.values.get(storageRef); }
}
