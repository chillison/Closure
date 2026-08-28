import type { GenerationLane, ModelProtocol } from '@orison/shared-contracts';

export type ProtocolCallContext = {
  signal?: AbortSignal;
  /**
   * Dispatch lane (dogfood R2 #7): selects the streaming first-event window
   * (interactive 60s vs background 240s) and gates the bounded non-streaming
   * timeout fallback (background only). Absent = interactive semantics — every
   * existing caller keeps byte-level identical behavior. Mirrors
   * TextGenerationRequest.lane, threaded by the shell gateway.
   */
  lane?: GenerationLane;
};

export type ListModelsRequest = {
  protocol?: ModelProtocol;
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
};
