export interface TastingLifecycleInput {
  request_id: string;
  expected_updated_at: string;
}
export interface TastingLifecycleResult {
  id: string;
  updated_at: string;
  deleted_at: string | null;
}
