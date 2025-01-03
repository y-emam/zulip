import {z} from "zod";

import type {StateData} from "./state_data.ts";

export const stream_notification_settings_schema = z.object({
    enable_stream_audible_notifications: z.boolean(),
    enable_stream_desktop_notifications: z.boolean(),
    enable_stream_email_notifications: z.boolean(),
    enable_stream_push_notifications: z.boolean(),
    wildcard_mentions_notify: z.boolean(),
});
export type StreamNotificationSettings = z.infer<typeof stream_notification_settings_schema>;

export const pm_notification_settings_schema = z.object({
    enable_desktop_notifications: z.boolean(),
    enable_offline_email_notifications: z.boolean(),
    enable_offline_push_notifications: z.boolean(),
    enable_sounds: z.boolean(),
});
export type PmNotificationSettings = z.infer<typeof pm_notification_settings_schema>;

export const followed_topic_notification_settings_schema = z.object({
    enable_followed_topic_audible_notifications: z.boolean(),
    enable_followed_topic_desktop_notifications: z.boolean(),
    enable_followed_topic_email_notifications: z.boolean(),
    enable_followed_topic_push_notifications: z.boolean(),
    enable_followed_topic_wildcard_mentions_notify: z.boolean(),
});
export type FollowedTopicNotificationSettings = z.infer<
    typeof followed_topic_notification_settings_schema
>;

export const user_settings_schema = stream_notification_settings_schema
    .merge(pm_notification_settings_schema)
    .merge(followed_topic_notification_settings_schema)
    .extend({
        allow_private_data_export: z.boolean(),
        automatically_follow_topics_policy: z.number(),
        automatically_follow_topics_where_mentioned: z.boolean(),
        automatically_unmute_topics_in_muted_streams_policy: z.number(),
        available_notification_sounds: z.array(z.string()),
        color_scheme: z.number(),
        default_language: z.string(),
        demote_inactive_streams: z.number(),
        dense_mode: z.boolean(),
        desktop_icon_count_display: z.number(),
        display_emoji_reaction_users: z.boolean(),
        email_address_visibility: z.number(),
        email_notifications_batching_period_seconds: z.number(),
        emojiset: z.string(),
        emojiset_choices: z.array(z.object({key: z.string(), text: z.string()})),
        enable_digest_emails: z.boolean(),
        enable_drafts_synchronization: z.boolean(),
        enable_login_emails: z.boolean(),
        enable_marketing_emails: z.boolean(),
        enable_online_push_notifications: z.boolean(),
        enter_sends: z.boolean(),
        fluid_layout_width: z.boolean(),
        high_contrast_mode: z.boolean(),
        left_side_userlist: z.boolean(),
        message_content_in_email_notifications: z.boolean(),
        notification_sound: z.string(),
        pm_content_in_desktop_notifications: z.boolean(),
        presence_enabled: z.boolean(),
        realm_name_in_email_notifications_policy: z.number(),
        receives_typing_notifications: z.boolean(),
        send_private_typing_notifications: z.boolean(),
        send_read_receipts: z.boolean(),
        send_stream_typing_notifications: z.boolean(),
        starred_message_counts: z.boolean(),
        timezone: z.string(),
        translate_emoticons: z.boolean(),
        twenty_four_hour_time: z.boolean(),
        user_list_style: z.number(),
        web_animate_image_previews: z.enum(["always", "on_hover", "never"]),
        web_channel_default_view: z.number(),
        web_escape_navigates_to_home_view: z.boolean(),
        web_font_size_px: z.number(),
        web_home_view: z.enum(["inbox", "recent_topics", "all_messages"]),
        web_line_height_percent: z.number(),
        web_mark_read_on_scroll_policy: z.number(),
        web_navigate_to_sent_message: z.boolean(),
        web_stream_unreads_count_display_policy: z.number(),
        web_suggest_update_timezone: z.boolean(),
    });
export type UserSettings = z.infer<typeof user_settings_schema>;

export let user_settings: UserSettings;

export function initialize_user_settings(params: StateData["user_settings"]): void {
    user_settings = params.user_settings;
}
