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
          can_activate: boolean
          cooldown_turns: number
          created_at: string
          description: string | null
          effects: Json
          end_effects: Json
          self_target_only: boolean
          id: string
          is_passive: boolean
          is_magical: boolean
          mana_cost: number
          name: string
          passive_effects: Json
        }
        Insert: {
          can_activate?: boolean
          cooldown_turns?: number
          created_at?: string
          description?: string | null
          effects?: Json
          end_effects?: Json
          self_target_only?: boolean
          id?: string
          is_passive?: boolean
          is_magical?: boolean
          mana_cost?: number
          name: string
          passive_effects?: Json
        }
        Update: {
          can_activate?: boolean
          cooldown_turns?: number
          created_at?: string
          description?: string | null
          effects?: Json
          end_effects?: Json
          self_target_only?: boolean
          id?: string
          is_passive?: boolean
          is_magical?: boolean
          mana_cost?: number
          name?: string
          passive_effects?: Json
        }
        Relationships: []
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
      battle_effects: {
        Row: {
          amount: number
          attribute_key: string | null
          battle_id: string | null
          character_id: string
          created_at: string
          duration: number
          duration_scope: string
          effect_group_id: string | null
          is_end_effect: boolean
          effect_type: string
          id: string
          name: string
          polarity: string
          source_character_ability_id: string | null
          value_mode: string
        }
        Insert: {
          amount?: number
          attribute_key?: string | null
          battle_id?: string | null
          character_id: string
          created_at?: string
          duration: number
          duration_scope?: string
          effect_group_id?: string | null
          is_end_effect?: boolean
          effect_type: string
          id?: string
          name: string
          polarity?: string
          source_character_ability_id?: string | null
          value_mode?: string
        }
        Update: {
          amount?: number
          attribute_key?: string | null
          battle_id?: string | null
          character_id?: string
          created_at?: string
          duration?: number
          duration_scope?: string
          effect_group_id?: string | null
          is_end_effect?: boolean
          effect_type?: string
          id?: string
          name?: string
          polarity?: string
          source_character_ability_id?: string | null
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
            foreignKeyName: "battle_effects_source_character_ability_id_fkey"
            columns: ["source_character_ability_id"]
            isOneToOne: false
            referencedRelation: "character_abilities"
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
          ability_id: string
          can_activate: boolean
          character_id: string
          cooldown_remaining: number
          cooldown_turns: number
          created_at: string
          description: string | null
          effects: Json
          end_effects: Json
          self_target_only: boolean
          granted_by_virtue_id: string | null
          id: string
          is_passive: boolean
          is_magical: boolean
          mana_cost: number
          name: string
          passive_effects: Json
        }
        Insert: {
          ability_id: string
          can_activate?: boolean
          character_id: string
          cooldown_remaining?: number
          cooldown_turns?: number
          created_at?: string
          description?: string | null
          effects?: Json
          end_effects?: Json
          self_target_only?: boolean
          granted_by_virtue_id?: string | null
          id?: string
          is_passive?: boolean
          is_magical?: boolean
          mana_cost?: number
          name: string
          passive_effects?: Json
        }
        Update: {
          ability_id?: string
          can_activate?: boolean
          character_id?: string
          cooldown_remaining?: number
          cooldown_turns?: number
          created_at?: string
          description?: string | null
          effects?: Json
          end_effects?: Json
          self_target_only?: boolean
          granted_by_virtue_id?: string | null
          id?: string
          is_passive?: boolean
          is_magical?: boolean
          mana_cost?: number
          name?: string
          passive_effects?: Json
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
            foreignKeyName: "character_abilities_granted_by_virtue_id_fkey"
            columns: ["granted_by_virtue_id"]
            isOneToOne: false
            referencedRelation: "virtues"
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
      characters: {
        Row: {
          available_points: number
          body: number
          created_at: string
          description: string | null
          id: string
          kills: number
          name: string
          owner_id: string | null
          photo_path: string | null
          player_name: string
          race_id: string | null
          race_points_granted: number
          sanity: number
          updated_at: string
          virtue_id: string | null
          virtue_points_granted: number
        }
        Insert: {
          available_points?: number
          body?: number
          created_at?: string
          description?: string | null
          id?: string
          kills?: number
          name: string
          owner_id?: string | null
          photo_path?: string | null
          player_name?: string
          race_id?: string | null
          race_points_granted?: number
          sanity?: number
          updated_at?: string
          virtue_id?: string | null
          virtue_points_granted?: number
        }
        Update: {
          available_points?: number
          body?: number
          created_at?: string
          description?: string | null
          id?: string
          kills?: number
          name?: string
          owner_id?: string | null
          photo_path?: string | null
          player_name?: string
          race_id?: string | null
          race_points_granted?: number
          sanity?: number
          updated_at?: string
          virtue_id?: string | null
          virtue_points_granted?: number
        }
        Relationships: [
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
      damage_types: {
        Row: {
          created_at: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
        }
        Update: {
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
      races: {
        Row: {
          bonus_points: number
          created_at: string
          description: string | null
          id: string
          modifiers: Json
          name: string
        }
        Insert: {
          bonus_points?: number
          created_at?: string
          description?: string | null
          id?: string
          modifiers?: Json
          name: string
        }
        Update: {
          bonus_points?: number
          created_at?: string
          description?: string | null
          id?: string
          modifiers?: Json
          name?: string
        }
        Relationships: []
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
      },
      virtues: {
        Row: {
          bonus_points: number
          created_at: string
          description: string | null
          id: string
          modifiers: Json
          name: string
        }
        Insert: {
          bonus_points?: number
          created_at?: string
          description?: string | null
          id?: string
          modifiers?: Json
          name: string
        }
        Update: {
          bonus_points?: number
          created_at?: string
          description?: string | null
          id?: string
          modifiers?: Json
          name?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      advance_combat_turn: {
        Args: {
          _mana_regeneration_settings?: Json
          _battle_id: string
          _character_id?: string | null
        }
        Returns: number
      }
      activate_character_ability: {
        Args: {
          _battle_id?: string | null
          _character_ability_id: string
          _target_character_id: string
        }
        Returns: number
      }
      apply_battle_damage: {
        Args: {
          _battle_id: string | null
          _character_id: string
          _damage_kind: string
          _damage_type_id: string | null
          _damage_values: Json
          _magic_level: string | null
          _source_character_id?: string | null
        }
        Returns: Json
      }
      choose_character_traits: {
        Args: { _character_id: string; _race_id: string; _virtue_id: string }
        Returns: undefined
      }
      choose_character_race: {
        Args: { _character_id: string; _race_id: string | null }
        Returns: undefined
      }
      choose_character_virtue: {
        Args: { _character_id: string; _virtue_id: string | null }
        Returns: undefined
      }
      choose_race: {
        Args: { _character_id: string; _race_id: string }
        Returns: undefined
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      in_my_battle: { Args: { _battle_id: string }; Returns: boolean }
      invest_points: {
        Args: { _allocations: Json; _character_id: string }
        Returns: undefined
      }
      shares_battle: { Args: { _character_id: string }; Returns: boolean }
      sync_my_role: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      tick_character_ability_cooldowns: {
        Args: { _character_id: string }
        Returns: undefined
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
