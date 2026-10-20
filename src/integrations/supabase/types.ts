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
      battles: {
        Row: {
          active: boolean
          created_at: string
          turn_count: number
          current_character_id: string | null
          id: string
          name: string
          target_character_id: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          turn_count?: number
          current_character_id?: string | null
          id?: string
          name?: string
          target_character_id?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          turn_count?: number
          current_character_id?: string | null
          id?: string
          name?: string
          target_character_id?: string | null
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
          mana_regen_mode: string
          mana_regen_amount: number
          name: string
          owner_id: string | null
          photo_path: string | null
          player_name: string
          race_id: string | null
          race_points_granted: number
          sanity: number
          updated_at: string
        }
        Insert: {
          available_points?: number
          body?: number
          created_at?: string
          description?: string | null
          id?: string
          kills?: number
          mana_regen_mode?: string
          mana_regen_amount?: number
          name: string
          owner_id?: string | null
          photo_path?: string | null
          player_name?: string
          race_id?: string | null
          race_points_granted?: number
          sanity?: number
          updated_at?: string
        }
        Update: {
          available_points?: number
          body?: number
          created_at?: string
          description?: string | null
          id?: string
          kills?: number
          mana_regen_mode?: string
          mana_regen_amount?: number
          name?: string
          owner_id?: string | null
          photo_path?: string | null
          player_name?: string
          race_id?: string | null
          race_points_granted?: number
          sanity?: number
          updated_at?: string
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
        ]
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      apply_battle_damage: {
        Args: {
          _battle_id: string | null
          _character_id: string
          _damage_kind: string
          _damage_type_id: string | null
          _damage_values: Json
          _magic_level: string | null
        }
        Returns: Json
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
