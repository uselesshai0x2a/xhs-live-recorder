export interface TargetMetadataStore {
  updateName(targetId: string, name: string): Promise<void>;
}
