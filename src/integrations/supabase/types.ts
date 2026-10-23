export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      abilities: {
        Row: {
          attack_damage: Json
          attack_effect_groups: Json
          attack_enabled: boolean
          can_activate: boolean
          cooldown_turns: number
          created_at: string
          custom_attributes: Json
          custom_script_key: string | null
          description: string | null
          dot_effects: Json
          effects: Json
          end_effects: Json
          id: string
          is_magical: boolean
          is_passive: boolean
          mana_cost: number
          name: string
          once_per_battle: boolean
          passive_effects: Json
          self_target_only: boolean
        }
        Insert: {
          attack_damage?: Json
          attack_effect_groups?: Json
          attack_enabled?: boolean
          can_activate?: boolean
          cooldown_turns?: number
          created_at?: string
          custom_attributes?: Json
          custom_script_key?: string | null
          description?: string | null
          dot_effects?: Json
          effects?: Json
          end_effects?: Json
          id?: string
          is_magical?: boolean
          is_passive?: boolean
          mana_cost?: number
          name: string
          once_per_battle?: boolean
          passive_effects?: Json
          self_target_only?: boolean
        }
        Update: {
          attack_damage?: Json
          attack_effect_groups?: Json
          attack_enabled?: boolean
          can_activate?: boolean
          cooldown_turns?: number
          created_at?: string
          custom_attributes?: Json
          custom_script_key?: string | null
          description?: string | null
          dot_effects?: Json
          effects?: Json
          end_effects?: Json
          id?: string
          is_magical?: boolean
          is_passive?: boolean
          mana_cost?: number
          name?: string
          once_per_battle?: boolean
          passive_effects?: Json
          self_target_only?: boolean
        }
        Relationships: []
      }
      ability_script_events: {
        Row: {
          ability_id: string | null
          attempts: number
          battle_id: string | null
          character_ability_id: string | null
          character_id: string
          created_at: string
          effect_id: string | null
          error_message: string | null
          event_type: string
          id: string
          locked_at: string | null
          payload: Json
          processed_at: string | null
          queue_order: number
          script_key: string
          status: string
          target_character_id: string | null
        }
        Insert: {
          ability_id?: string | null
          attempts?: number
          battle_id?: string | null
          character_ability_id?: string | null
          character_id: string
          created_at?: string
          effect_id?: string | null
          error_message?: string | null
          event_type: string
          id?: string
          locked_at?: string | null
          payload?: Json
          processed_at?: string | null
          queue_order?: never
          script_key: string
          status?: string
          target_character_id?: string | null
        }
        Update: {
          ability_id?: string | null
          attempts?: number
          battle_id?: string | null
          character_ability_id?: string | null
          character_id?: string
          created_at?: string
          effect_id?: string | null
          error_message?: string | null
          event_type?: string
          id?: string
          locked_at?: string | null
          payload?: Json
          processed_at?: string | null
          queue_order?: never
          script_key?: string
          status?: string
          target_character_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ability_script_events_ability_id_fkey"
            columns: ["ability_id"]
            isOneToOne: false
            referencedRelation: "abilities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ability_script_events_battle_id_fkey"
            columns: ["battle_id"]
            isOneToOne: false
            referencedRelation: "battles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ability_script_events_character_ability_id_fkey"
            columns: ["character_ability_id"]
            isOneToOne: false
            referencedRelation: "character_abilities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ability_script_events_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ability_script_events_target_character_id_fkey"
            columns: ["target_character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
        ]
      }
      attribute_definitions: {
        Row: {
          accepts_points: boolean
          base_value: number
          cap_current: boolean
          icon: string
          key: string
          label: string
          points_multiplier: number
          show_bar: boolean
          sort_order: number
        }
        Insert: {
          accepts_points?: boolean
          base_value?: number
          cap_current?: boolean
          icon?: string
          key: string
          label: string
          points_multiplier?: number
          show_bar?: boolean
          sort_order?: number
        }
        Update: {
          accepts_points?: boolean
          base_value?: number
          cap_current?: boolean
          icon?: string
          key?: string
          label?: string
          points_multiplier?: number
          show_bar?: boolean
          sort_order?: number
        }
        Relationships: []
      }
      battle_ability_overrides: {
        Row: {
          battle_id: string
          character_ability_id: string
          keep_after_use: boolean
          override_values: Json
          updated_at: string
        }
        Insert: {
          battle_id: string
          character_ability_id: string
          keep_after_use?: boolean
          override_values?: Json
          updated_at?: string
        }
        Update: {
          battle_id?: string
          character_ability_id?: string
          keep_after_use?: boolean
          override_values?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "battle_ability_overrides_battle_id_fkey"
            columns: ["battle_id"]
            isOneToOne: false
            referencedRelation: "battles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "battle_ability_overrides_character_ability_id_fkey"
            columns: ["character_ability_id"]
            isOneToOne: false
            referencedRelation: "character_abilities"
            referencedColumns: ["id"]
          },
        ]
      }
      battle_effects: {
        Row: {
          amount: number
          attribute_key: string | null
          battle_id: string | null
          character_id: string
          created_at: string
          damage_reduction_magic_level: string | null
          damage_reduction_magic_levels: string[] | null
          damage_reduction_scope: string
          damage_reduction_type_id: string | null
          damage_reduction_type_ids: string[] | null
          damage_scope: string
          duration: number
          duration_scope: string
          effect_data: Json
          effect_group_id: string | null
          effect_type: string
          id: string
          is_end_effect: boolean
          is_sheet_permanent: boolean
          name: string
          polarity: string
          source_character_ability_id: string | null
          source_class_effect_index: number | null
          source_class_id: string | null
          source_race_effect_index: number | null
          source_race_id: string | null
          source_virtue_effect_index: number | null
          source_virtue_id: string | null
          target_character_id: string | null
          until_combat_end: boolean
          value_mode: string
        }
        Insert: {
          amount?: number
          attribute_key?: string | null
          battle_id?: string | null
          character_id: string
          created_at?: string
          damage_reduction_magic_level?: string | null
          damage_reduction_magic_levels?: string[] | null
          damage_reduction_scope?: string
          damage_reduction_type_id?: string | null
          damage_reduction_type_ids?: string[] | null
          damage_scope?: string
          duration: number
          duration_scope?: string
          effect_data?: Json
          effect_group_id?: string | null
          effect_type: string
          id?: string
          is_end_effect?: boolean
          is_sheet_permanent?: boolean
          name: string
          polarity?: string
          source_character_ability_id?: string | null
          source_class_effect_index?: number | null
          source_class_id?: string | null
          source_race_effect_index?: number | null
          source_race_id?: string | null
          source_virtue_effect_index?: number | null
          source_virtue_id?: string | null
          target_character_id?: string | null
          until_combat_end?: boolean
          value_mode?: string
        }
        Update: {
          amount?: number
          attribute_key?: string | null
          battle_id?: string | null
          character_id?: string
          created_at?: string
          damage_reduction_magic_level?: string | null
          damage_reduction_magic_levels?: string[] | null
          damage_reduction_scope?: string
          damage_reduction_type_id?: string | null
          damage_reduction_type_ids?: string[] | null
          damage_scope?: string
          duration?: number
          duration_scope?: string
          effect_data?: Json
          effect_group_id?: string | null
          effect_type?: string
          id?: string
          is_end_effect?: boolean
          is_sheet_permanent?: boolean
          name?: string
          polarity?: string
          source_character_ability_id?: string | null
          source_class_effect_index?: number | null
          source_class_id?: string | null
          source_race_effect_index?: number | null
          source_race_id?: string | null
          source_virtue_effect_index?: number | null
          source_virtue_id?: string | null
          target_character_id?: string | null
          until_combat_end?: boolean
          value_mode?: string
        }
        Relationships: [
          {
            foreignKeyName: "battle_effects_battle_id_fkey"
            columns: ["battle_id"]
            isOneToOne: false
            referencedRelation: "battles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "battle_effects_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "battle_effects_damage_reduction_type_id_fkey"
            columns: ["damage_reduction_type_id"]
            isOneToOne: false
            referencedRelation: "damage_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "battle_effects_source_character_ability_id_fkey"
            columns: ["source_character_ability_id"]
            isOneToOne: false
            referencedRelation: "character_abilities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "battle_effects_source_class_id_fkey"
            columns: ["source_class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "battle_effects_source_race_id_fkey"
            columns: ["source_race_id"]
            isOneToOne: false
            referencedRelation: "races"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "battle_effects_source_virtue_id_fkey"
            columns: ["source_virtue_id"]
            isOneToOne: false
            referencedRelation: "virtues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "battle_effects_target_character_id_fkey"
            columns: ["target_character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
        ]
      }
      battle_participants: {
        Row: {
          battle_id: string
          character_id: string
          sort_order: number
          turn_count: number
        }
        Insert: {
          battle_id: string
          character_id: string
          sort_order?: number
          turn_count?: number
        }
        Update: {
          battle_id?: string
          character_id?: string
          sort_order?: number
          turn_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "battle_participants_battle_id_fkey"
            columns: ["battle_id"]
            isOneToOne: false
            referencedRelation: "battles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "battle_participants_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
        ]
      }
      battles: {
        Row: {
          active: boolean
          created_at: string
          current_character_id: string | null
          id: string
          name: string
          target_character_id: string | null
          turn_count: number
        }
        Insert: {
          active?: boolean
          created_at?: string
          current_character_id?: string | null
          id?: string
          name?: string
          target_character_id?: string | null
          turn_count?: number
        }
        Update: {
          active?: boolean
          created_at?: string
          current_character_id?: string | null
          id?: string
          name?: string
          target_character_id?: string | null
          turn_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "battles_current_character_id_fkey"
            columns: ["current_character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "battles_target_character_id_fkey"
            columns: ["target_character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
        ]
      }
      character_abilities: {
        Row: {
          ability_id: string | null
          can_activate: boolean
          character_id: string
          cooldown_remaining: number
          cooldown_turns: number
          created_at: string
          custom_attributes: Json | null
          custom_state: Json
          description: string | null
          effects: Json
          end_effects: Json
          granted_by_class_id: string | null
          granted_by_race_id: string | null
          granted_by_transformation_id: string | null
          granted_by_virtue_id: string | null
          granted_only_while_transformed: boolean
          id: string
          is_magical: boolean
          is_passive: boolean
          mana_cost: number
          name: string
          once_per_battle: boolean
          passive_effects: Json
          self_target_only: boolean
        }
        Insert: {
          ability_id?: string | null
          can_activate?: boolean
          character_id: string
          cooldown_remaining?: number
          cooldown_turns?: number
          created_at?: string
          custom_attributes?: Json | null
          custom_state?: Json
          description?: string | null
          effects?: Json
          end_effects?: Json
          granted_by_class_id?: string | null
          granted_by_race_id?: string | null
          granted_by_transformation_id?: string | null
          granted_by_virtue_id?: string | null
          granted_only_while_transformed?: boolean
          id?: string
          is_magical?: boolean
          is_passive?: boolean
          mana_cost?: number
          name: string
          once_per_battle?: boolean
          passive_effects?: Json
          self_target_only?: boolean
        }
        Update: {
          ability_id?: string | null
          can_activate?: boolean
          character_id?: string
          cooldown_remaining?: number
          cooldown_turns?: number
          created_at?: string
          custom_attributes?: Json | null
          custom_state?: Json
          description?: string | null
          effects?: Json
          end_effects?: Json
          granted_by_class_id?: string | null
          granted_by_race_id?: string | null
          granted_by_transformation_id?: string | null
          granted_by_virtue_id?: string | null
          granted_only_while_transformed?: boolean
          id?: string
          is_magical?: boolean
          is_passive?: boolean
          mana_cost?: number
          name?: string
          once_per_battle?: boolean
          passive_effects?: Json
          self_target_only?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "character_abilities_ability_id_fkey"
            columns: ["ability_id"]
            isOneToOne: false
            referencedRelation: "abilities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_abilities_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_abilities_granted_by_class_id_fkey"
            columns: ["granted_by_class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_abilities_granted_by_race_id_fkey"
            columns: ["granted_by_race_id"]
            isOneToOne: false
            referencedRelation: "races"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_abilities_granted_by_transformation_id_fkey"
            columns: ["granted_by_transformation_id"]
            isOneToOne: false
            referencedRelation: "transformations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_abilities_granted_by_virtue_id_fkey"
            columns: ["granted_by_virtue_id"]
            isOneToOne: false
            referencedRelation: "virtues"
            referencedColumns: ["id"]
          },
        ]
      }
      character_ability_battle_uses: {
        Row: {
          battle_id: string
          character_ability_id: string
          character_id: string
          used_at: string
        }
        Insert: {
          battle_id: string
          character_ability_id: string
          character_id: string
          used_at?: string
        }
        Update: {
          battle_id?: string
          character_ability_id?: string
          character_id?: string
          used_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "character_ability_battle_uses_battle_id_fkey"
            columns: ["battle_id"]
            isOneToOne: false
            referencedRelation: "battles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_ability_battle_uses_character_ability_id_fkey"
            columns: ["character_ability_id"]
            isOneToOne: false
            referencedRelation: "character_abilities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_ability_battle_uses_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
        ]
      }
      character_attributes: {
        Row: {
          attribute_key: string
          bonus: number
          character_id: string
          current_value: number
          max_value: number
          points: number
          updated_at: string
        }
        Insert: {
          attribute_key: string
          bonus?: number
          character_id: string
          current_value?: number
          max_value?: number
          points?: number
          updated_at?: string
        }
        Update: {
          attribute_key?: string
          bonus?: number
          character_id?: string
          current_value?: number
          max_value?: number
          points?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "character_attributes_attribute_key_fkey"
            columns: ["attribute_key"]
            isOneToOne: false
            referencedRelation: "attribute_definitions"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "character_attributes_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
        ]
      }
      character_transformations: {
        Row: {
          activated_at: string | null
          active: boolean
          active_battle_id: string | null
          active_duration_remaining: number
          active_effect_group_id: string | null
          applied_attribute_modifiers: Json
          applied_body_delta: number
          applied_sanity_delta: number
          character_id: string
          cooldown_remaining: number
          image_path: string | null
          transformation_id: string
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          active?: boolean
          active_battle_id?: string | null
          active_duration_remaining?: number
          active_effect_group_id?: string | null
          applied_attribute_modifiers?: Json
          applied_body_delta?: number
          applied_sanity_delta?: number
          character_id: string
          cooldown_remaining?: number
          image_path?: string | null
          transformation_id: string
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          active?: boolean
          active_battle_id?: string | null
          active_duration_remaining?: number
          active_effect_group_id?: string | null
          applied_attribute_modifiers?: Json
          applied_body_delta?: number
          applied_sanity_delta?: number
          character_id?: string
          cooldown_remaining?: number
          image_path?: string | null
          transformation_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "character_transformations_active_battle_id_fkey"
            columns: ["active_battle_id"]
            isOneToOne: false
            referencedRelation: "battles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_transformations_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_transformations_transformation_id_fkey"
            columns: ["transformation_id"]
            isOneToOne: false
            referencedRelation: "transformations"
            referencedColumns: ["id"]
          },
        ]
      }
      characters: {
        Row: {
          available_points: number
          body: number
          class_attribute_allocations: Json
          class_custom_modifiers: Json
          class_id: string | null
          class_physical_allocations: Json
          class_physical_points_granted: number
          class_points_granted: number
          created_at: string
          description: string | null
          id: string
          kills: number
          name: string
          owner_id: string | null
          photo_path: string | null
          player_name: string
          race_attribute_allocations: Json
          race_id: string | null
          race_physical_allocations: Json
          race_physical_points_granted: number
          race_points_granted: number
          sanity: number
          updated_at: string
          virtue_attribute_allocations: Json
          virtue_id: string | null
          virtue_physical_allocations: Json
          virtue_physical_points_granted: number
          virtue_points_granted: number
        }
        Insert: {
          available_points?: number
          body?: number
          class_attribute_allocations?: Json
          class_custom_modifiers?: Json
          class_id?: string | null
          class_physical_allocations?: Json
          class_physical_points_granted?: number
          class_points_granted?: number
          created_at?: string
          description?: string | null
          id?: string
          kills?: number
          name: string
          owner_id?: string | null
          photo_path?: string | null
          player_name?: string
          race_attribute_allocations?: Json
          race_id?: string | null
          race_physical_allocations?: Json
          race_physical_points_granted?: number
          race_points_granted?: number
          sanity?: number
          updated_at?: string
          virtue_attribute_allocations?: Json
          virtue_id?: string | null
          virtue_physical_allocations?: Json
          virtue_physical_points_granted?: number
          virtue_points_granted?: number
        }
        Update: {
          available_points?: number
          body?: number
          class_attribute_allocations?: Json
          class_custom_modifiers?: Json
          class_id?: string | null
          class_physical_allocations?: Json
          class_physical_points_granted?: number
          class_points_granted?: number
          created_at?: string
          description?: string | null
          id?: string
          kills?: number
          name?: string
          owner_id?: string | null
          photo_path?: string | null
          player_name?: string
          race_attribute_allocations?: Json
          race_id?: string | null
          race_physical_allocations?: Json
          race_physical_points_granted?: number
          race_points_granted?: number
          sanity?: number
          updated_at?: string
          virtue_attribute_allocations?: Json
          virtue_id?: string | null
          virtue_physical_allocations?: Json
          virtue_physical_points_granted?: number
          virtue_points_granted?: number
        }
        Relationships: [
          {
            foreignKeyName: "characters_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "characters_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "characters_race_id_fkey"
            columns: ["race_id"]
            isOneToOne: false
            referencedRelation: "races"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "characters_virtue_id_fkey"
            columns: ["virtue_id"]
            isOneToOne: false
            referencedRelation: "virtues"
            referencedColumns: ["id"]
          },
        ]
      }
      class_abilities: {
        Row: {
          ability_id: string
          class_id: string
          created_at: string
        }
        Insert: {
          ability_id: string
          class_id: string
          created_at?: string
        }
        Update: {
          ability_id?: string
          class_id?: string
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "class_abilities_ability_id_fkey"
            columns: ["ability_id"]
            isOneToOne: false
            referencedRelation: "abilities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "class_abilities_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
        ]
      }
      class_transformations: {
        Row: {
          class_id: string
          created_at: string
          transformation_id: string
        }
        Insert: {
          class_id: string
          created_at?: string
          transformation_id: string
        }
        Update: {
          class_id?: string
          created_at?: string
          transformation_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "class_transformations_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "class_transformations_transformation_id_fkey"
            columns: ["transformation_id"]
            isOneToOne: false
            referencedRelation: "transformations"
            referencedColumns: ["id"]
          },
        ]
      }
      classes: {
        Row: {
          bonus_points: number
          created_at: string
          description: string | null
          id: string
          modifiers: Json
          name: string
          physical_bonus_points: number
          special_mechanics: Json
          starting_effects: Json
        }
        Insert: {
          bonus_points?: number
          created_at?: string
          description?: string | null
          id?: string
          modifiers?: Json
          name: string
          physical_bonus_points?: number
          special_mechanics?: Json
          starting_effects?: Json
        }
        Update: {
          bonus_points?: number
          created_at?: string
          description?: string | null
          id?: string
          modifiers?: Json
          name?: string
          physical_bonus_points?: number
          special_mechanics?: Json
          starting_effects?: Json
        }
        Relationships: []
      }
      damage_over_time_templates: {
        Row: {
          created_at: string
          damage_kind: string
          damage_type_id: string | null
          id: string
          magic_level: string | null
          name: string
          physical_damage_type_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          damage_kind: string
          damage_type_id?: string | null
          id?: string
          magic_level?: string | null
          name: string
          physical_damage_type_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          damage_kind?: string
          damage_type_id?: string | null
          id?: string
          magic_level?: string | null
          name?: string
          physical_damage_type_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "damage_over_time_templates_damage_type_id_fkey"
            columns: ["damage_type_id"]
            isOneToOne: false
            referencedRelation: "damage_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "damage_over_time_templates_physical_damage_type_id_fkey"
            columns: ["physical_damage_type_id"]
            isOneToOne: false
            referencedRelation: "damage_types"
            referencedColumns: ["id"]
          },
        ]
      }
      damage_types: {
        Row: {
          category: string
          created_at: string
          id: string
          name: string
        }
        Insert: {
          category?: string
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      master_emails: {
        Row: {
          email: string
        }
        Insert: {
          email: string
        }
        Update: {
          email?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string
          email: string | null
          id: string
        }
        Insert: {
          created_at?: string
          display_name?: string
          email?: string | null
          id: string
        }
        Update: {
          created_at?: string
          display_name?: string
          email?: string | null
          id?: string
        }
        Relationships: []
      }
      race_abilities: {
        Row: {
          ability_id: string
          created_at: string
          race_id: string
        }
        Insert: {
          ability_id: string
          created_at?: string
          race_id: string
        }
        Update: {
          ability_id?: string
          created_at?: string
          race_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "race_abilities_ability_id_fkey"
            columns: ["ability_id"]
            isOneToOne: false
            referencedRelation: "abilities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "race_abilities_race_id_fkey"
            columns: ["race_id"]
            isOneToOne: false
            referencedRelation: "races"
            referencedColumns: ["id"]
          },
        ]
      }
      race_transformations: {
        Row: {
          race_id: string
          transformation_id: string
        }
        Insert: {
          race_id: string
          transformation_id: string
        }
        Update: {
          race_id?: string
          transformation_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "race_transformations_race_id_fkey"
            columns: ["race_id"]
            isOneToOne: false
            referencedRelation: "races"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "race_transformations_transformation_id_fkey"
            columns: ["transformation_id"]
            isOneToOne: false
            referencedRelation: "transformations"
            referencedColumns: ["id"]
          },
        ]
      }
      races: {
        Row: {
          bonus_points: number
          created_at: string
          description: string | null
          id: string
          modifiers: Json
          name: string
          physical_bonus_points: number
          special_mechanics: Json
          starting_effects: Json
        }
        Insert: {
          bonus_points?: number
          created_at?: string
          description?: string | null
          id?: string
          modifiers?: Json
          name: string
          physical_bonus_points?: number
          special_mechanics?: Json
          starting_effects?: Json
        }
        Update: {
          bonus_points?: number
          created_at?: string
          description?: string | null
          id?: string
          modifiers?: Json
          name?: string
          physical_bonus_points?: number
          special_mechanics?: Json
          starting_effects?: Json
        }
        Relationships: []
      }
      transformation_abilities: {
        Row: {
          ability_id: string
          created_at: string
          only_while_transformed: boolean
          transformation_id: string
        }
        Insert: {
          ability_id: string
          created_at?: string
          only_while_transformed?: boolean
          transformation_id: string
        }
        Update: {
          ability_id?: string
          created_at?: string
          only_while_transformed?: boolean
          transformation_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transformation_abilities_ability_id_fkey"
            columns: ["ability_id"]
            isOneToOne: false
            referencedRelation: "abilities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transformation_abilities_transformation_id_fkey"
            columns: ["transformation_id"]
            isOneToOne: false
            referencedRelation: "transformations"
            referencedColumns: ["id"]
          },
        ]
      }
      transformations: {
        Row: {
          cooldown_turns: number
          created_at: string
          description: string | null
          duration_turns: number
          effects: Json
          end_effects: Json
          id: string
          mana_cost: number
          modifiers: Json
          name: string
          owner_character_id: string | null
          source_transformation_id: string | null
          updated_at: string
        }
        Insert: {
          cooldown_turns?: number
          created_at?: string
          description?: string | null
          duration_turns?: number
          effects?: Json
          end_effects?: Json
          id?: string
          mana_cost?: number
          modifiers?: Json
          name: string
          owner_character_id?: string | null
          source_transformation_id?: string | null
          updated_at?: string
        }
        Update: {
          cooldown_turns?: number
          created_at?: string
          description?: string | null
          duration_turns?: number
          effects?: Json
          end_effects?: Json
          id?: string
          mana_cost?: number
          modifiers?: Json
          name?: string
          owner_character_id?: string | null
          source_transformation_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "transformations_owner_character_id_fkey"
            columns: ["owner_character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transformations_source_transformation_id_fkey"
            columns: ["source_transformation_id"]
            isOneToOne: false
            referencedRelation: "transformations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      virtue_abilities: {
        Row: {
          ability_id: string
          created_at: string
          virtue_id: string
        }
        Insert: {
          ability_id: string
          created_at?: string
          virtue_id: string
        }
        Update: {
          ability_id?: string
          created_at?: string
          virtue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "virtue_abilities_ability_id_fkey"
            columns: ["ability_id"]
            isOneToOne: false
            referencedRelation: "abilities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "virtue_abilities_virtue_id_fkey"
            columns: ["virtue_id"]
            isOneToOne: false
            referencedRelation: "virtues"
            referencedColumns: ["id"]
          },
        ]
      }
      virtue_transformations: {
        Row: {
          transformation_id: string
          virtue_id: string
        }
        Insert: {
          transformation_id: string
          virtue_id: string
        }
        Update: {
          transformation_id?: string
          virtue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "virtue_transformations_transformation_id_fkey"
            columns: ["transformation_id"]
            isOneToOne: false
            referencedRelation: "transformations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "virtue_transformations_virtue_id_fkey"
            columns: ["virtue_id"]
            isOneToOne: false
            referencedRelation: "virtues"
            referencedColumns: ["id"]
          },
        ]
      }
      virtues: {
        Row: {
          bonus_points: number
          created_at: string
          description: string | null
          id: string
          modifiers: Json
          name: string
          physical_bonus_points: number
          starting_effects: Json
        }
        Insert: {
          bonus_points?: number
          created_at?: string
          description?: string | null
          id?: string
          modifiers?: Json
          name: string
          physical_bonus_points?: number
          starting_effects?: Json
        }
        Update: {
          bonus_points?: number
          created_at?: string
          description?: string | null
          id?: string
          modifiers?: Json
          name?: string
          physical_bonus_points?: number
          starting_effects?: Json
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      activate_character_ability: {
        Args: {
          _battle_id?: string
          _character_ability_id: string
          _dot_attribute_values?: Json
          _dot_target_selections?: Json
          _extra_mana_cost?: number
          _target_character_id: string
        }
        Returns: number
      }
      activate_character_ability_attack: {
        Args: {
          _battle_id?: string
          _character_ability_id: string
          _dot_attribute_values?: Json
          _dot_target_selections?: Json
          _extra_mana_cost?: number
          _hit_effect_groups?: Json
          _hit_target_ids?: string[]
          _target_character_id: string
        }
        Returns: number
      }
      activate_character_transformation: {
        Args: {
          _battle_id: string
          _character_id: string
          _transformation_id: string
        }
        Returns: Json
      }
      adjust_character_ability_custom_state_number: {
        Args: {
          _character_ability_id: string
          _delta: number
          _key: string
          _minimum?: number
        }
        Returns: Json
      }
      adjust_character_hp_for_custom_damage: {
        Args: { _character_id: string; _damage_delta: number }
        Returns: number
      }
      advance_combat_turn: {
        Args: {
          _battle_id: string
          _character_id?: string
          _mana_regeneration_settings?: Json
        }
        Returns: number
      }
      apply_ability_dot_effect_internal: {
        Args: {
          _ability_name: string
          _attribute_values: Json
          _battle_id: string
          _caster_character_id: string
          _dot: Json
          _target_character_id: string
        }
        Returns: undefined
      }
      apply_ability_healing: {
        Args: {
          _apply_debuff_changes?: boolean
          _apply_resources?: boolean
          _battle_id: string
          _character_id: string
          _config: Json
        }
        Returns: undefined
      }
      apply_battle_damage: {
        Args: {
          _battle_id: string
          _character_id: string
          _damage_kind: string
          _damage_type_id: string
          _damage_values: Json
          _magic_level: string
          _physical_damage_type_id?: string
          _source_character_id?: string
        }
        Returns: Json
      }
      apply_battle_damage_critical: {
        Args: {
          _battle_id: string
          _character_id: string
          _damage_kind: string
          _damage_type_id: string
          _damage_values: Json
          _magic_level: string
          _physical_damage_type_id?: string
          _source_character_id?: string
        }
        Returns: Json
      }
      apply_character_ability_dots: {
        Args: {
          _attribute_values?: Json
          _battle_id: string
          _character_ability_id: string
          _target_selections: Json
        }
        Returns: number
      }
      apply_character_transformation_effects: {
        Args: {
          _active_duration: number
          _battle_id: string
          _character_id: string
          _effect_group_id: string
          _effects: Json
          _is_end_effect: boolean
          _transformation_id: string
        }
        Returns: number
      }
      apply_manual_character_effects: {
        Args: {
          _battle_id?: string
          _character_id: string
          _dots?: Json
          _effects?: Json
          _permanent?: boolean
          _source_character_id?: string
        }
        Returns: number
      }
      apply_mind_control_effects: {
        Args: {
          _battle_id: string
          _controller_character_id: string
          _target_selections: Json
        }
        Returns: number
      }
      calculate_character_resource_max: {
        Args: {
          _attribute_key: string
          _character_id: string
          _exclude_battle_effect_id?: string
          _exclude_character_ability_id?: string
          _extra_active_effects?: Json
          _extra_passive_effects?: Json
        }
        Returns: number
      }
      can_read_character_photo: {
        Args: { _photo_character_id: string }
        Returns: boolean
      }
      character_has_no_mana: {
        Args: { _character_id: string }
        Returns: boolean
      }
      character_is_immune_to_dot: {
        Args: { _battle_id: string; _dot: Json; _target_character_id: string }
        Returns: boolean
      }
      choose_character_class: {
        Args: {
          _character_id: string
          _class_id: string
          _custom_modifiers?: Json
        }
        Returns: undefined
      }
      choose_character_race: {
        Args: { _character_id: string; _race_id: string }
        Returns: undefined
      }
      choose_character_traits: {
        Args: { _character_id: string; _race_id: string; _virtue_id: string }
        Returns: undefined
      }
      choose_character_virtue: {
        Args: { _character_id: string; _virtue_id: string }
        Returns: undefined
      }
      choose_race: {
        Args: { _character_id: string; _race_id: string }
        Returns: undefined
      }
      claim_ability_script_events: {
        Args: { _batch_size?: number; _battle_id?: string }
        Returns: {
          ability_id: string | null
          attempts: number
          battle_id: string | null
          character_ability_id: string | null
          character_id: string
          created_at: string
          effect_id: string | null
          error_message: string | null
          event_type: string
          id: string
          locked_at: string | null
          payload: Json
          processed_at: string | null
          queue_order: number
          script_key: string
          status: string
          target_character_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "ability_script_events"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      end_character_transformation_internal: {
        Args: {
          _character_id: string
          _force_standalone?: boolean
          _transformation_id: string
        }
        Returns: undefined
      }
      get_battle_character_public_states: {
        Args: { _battle_id: string }
        Returns: {
          character_id: string
          hp_state: string
          mana_state: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      in_my_battle: { Args: { _battle_id: string }; Returns: boolean }
      increment_character_ability_custom_state_number: {
        Args: { _character_ability_id: string; _delta: number; _key: string }
        Returns: Json
      }
      invest_physical_points: {
        Args: { _allocations: Json; _character_id: string }
        Returns: undefined
      }
      invest_physical_points_from_source: {
        Args: { _allocations: Json; _character_id: string; _source: string }
        Returns: undefined
      }
      invest_points: {
        Args: { _allocations: Json; _character_id: string }
        Returns: undefined
      }
      invest_points_from_source: {
        Args: { _allocations: Json; _character_id: string; _source: string }
        Returns: undefined
      }
      merge_character_ability_custom_state: {
        Args: { _character_ability_id: string; _patch: Json }
        Returns: Json
      }
      queue_ability_script_event: {
        Args: {
          _battle_id?: string
          _character_ability_id: string
          _character_id: string
          _effect_id?: string
          _event_type: string
          _payload?: Json
          _target_character_id?: string
        }
        Returns: string
      }
      refresh_character_mana_for_no_mana: {
        Args: { _character_id: string }
        Returns: undefined
      }
      remove_attack_cancellable_effects: {
        Args: { _battle_id: string; _character_id: string }
        Returns: number
      }
      scale_character_resource_current: {
        Args: {
          _attribute_key: string
          _character_id: string
          _new_max: number
          _old_max: number
        }
        Returns: undefined
      }
      scale_racial_virtue_effect_json: {
        Args: { _multiplier: number; _value: Json }
        Returns: Json
      }
      set_character_transformation_image: {
        Args: {
          _character_id: string
          _image_path: string
          _transformation_id: string
        }
        Returns: undefined
      }
      shares_battle: { Args: { _character_id: string }; Returns: boolean }
      sync_character_class_effects: {
        Args: { _character_id: string }
        Returns: undefined
      }
      sync_character_race_effects: {
        Args: { _character_id: string }
        Returns: undefined
      }
      sync_character_trait_abilities: {
        Args: { _character_id: string }
        Returns: undefined
      }
      sync_character_virtue_effects: {
        Args: { _character_id: string }
        Returns: undefined
      }
      sync_coracao_corrompido_strength_effect: {
        Args: { _character_id: string }
        Returns: undefined
      }
      sync_coracao_corrompido_strength_effect_internal: {
        Args: { _bonus_strength?: number; _character_id: string }
        Returns: undefined
      }
      sync_coracao_corrompido_strength_effect_with_bonus: {
        Args: { _bonus_strength: number; _character_id: string }
        Returns: undefined
      }
      sync_my_role: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      sync_race_ability_assignments: {
        Args: { _race_id: string }
        Returns: undefined
      }
      sync_transformation_ability_grants_for_character: {
        Args: {
          _active: boolean
          _character_id: string
          _transformation_id: string
        }
        Returns: undefined
      }
      sync_virtue_ability_assignments: {
        Args: { _virtue_id: string }
        Returns: undefined
      }
      tick_character_ability_cooldowns: {
        Args: { _character_id: string }
        Returns: undefined
      }
      trigger_damage_vulnerability_effects: {
        Args: {
          _battle_id: string
          _character_id: string
          _damage_kind: string
          _damage_total: number
          _damage_type_id: string
          _magic_level: string
          _physical_damage_type_id: string
        }
        Returns: number
      }
      update_character_ability_custom_attributes: {
        Args: { _character_ability_id: string; _custom_attributes: Json }
        Returns: Json
      }
    }
    Enums: {
      app_role: "master" | "player"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["master", "player"],
    },
  },
} as const
