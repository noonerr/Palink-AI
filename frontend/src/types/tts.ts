export type TTSRole = 'character' | 'narrator'

export interface TTSSegment {
  type: 'dialogue' | 'narration'
  text: string
  characterId?: string
  characterName?: string
}

export interface TTSVoiceOption {
  voice_id: string
  gender?: string
  description?: string
  provider_id?: string
  is_clone?: boolean
  clone_sample_id?: string
}

export interface TTSProvider {
  id: string
  name: string
  description?: string
  engine_type: 'browser' | 'xiaomi_mimo' | 'custom_api' | string
  voices?: TTSVoiceOption[]
  is_builtin?: boolean
  config_fields?: Array<Record<string, unknown>>
  config?: Record<string, string>
}

export interface TTSVoiceBinding {
  id?: string
  scope?: 'global' | 'user' | 'character'
  user_id?: number | null
  character_id?: string | null
  role: TTSRole
  provider_id?: string | null
  voice_id?: string | null
  gender?: string | null
  clone_sample_id?: string | null
  speed?: number
  volume?: number
  enabled?: boolean
  inherited?: boolean
}

export interface TTSResolvedVoice {
  provider_id: string
  engine_type?: string
  voice_id: string
  gender: string
  clone_sample_id?: string | null
  role: TTSRole
  text?: string
  speed?: number
  volume?: number
  source?: string
}

export interface TTSBindingState {
  explicit?: TTSVoiceBinding | null
  resolved: TTSResolvedVoice
}

export interface TTSCloneSample {
  id: string
  name: string
  provider_id: string
  source_voice_id?: string | null
  filename: string
  file_size: number
  mime_type?: string | null
  duration_seconds?: number | null
  created_at?: string
  updated_at?: string
  usage_count?: number
}

export interface TTSManagementState {
  enabled: boolean
  active_provider_id: string
  segmented_playback: boolean
  providers: TTSProvider[]
  voices: TTSVoiceOption[]
  global_bindings: Record<TTSRole, TTSVoiceBinding | null>
  my_bindings: Record<TTSRole, TTSBindingState>
  clone_samples: TTSCloneSample[]
  can_admin: boolean
}

export interface TTSBindingPayload {
  role: TTSRole
  provider_id?: string | null
  voice_id?: string | null
  gender?: string | null
  clone_sample_id?: string | null
  speed?: number
  volume?: number
  enabled?: boolean
  inherit?: boolean
}

export interface TTSPreviewRequest {
  text?: string
  voice_description?: string
  role: TTSRole
  character_id?: string
  binding_override?: Partial<TTSBindingPayload>
}

export interface TTSPreviewMetadata extends TTSResolvedVoice {
  success: boolean
  is_dialogue: boolean
  is_narrator: boolean
}
