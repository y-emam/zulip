import $ from "jquery";
import _ from "lodash";
import assert from "minimalistic-assert";
import type * as tippy from "tippy.js";
import {z} from "zod";

import render_inbox_row from "../templates/inbox_view/inbox_row.hbs";
import render_inbox_stream_container from "../templates/inbox_view/inbox_stream_container.hbs";
import render_inbox_view from "../templates/inbox_view/inbox_view.hbs";
import render_introduce_zulip_view_modal from "../templates/introduce_zulip_view_modal.hbs";
import render_user_with_status_icon from "../templates/user_with_status_icon.hbs";

import * as buddy_data from "./buddy_data.ts";
import * as compose_closed_ui from "./compose_closed_ui.ts";
import * as compose_state from "./compose_state.ts";
import * as dialog_widget from "./dialog_widget.ts";
import * as dropdown_widget from "./dropdown_widget.ts";
import * as hash_util from "./hash_util.ts";
import {$t_html} from "./i18n.ts";
import {is_visible, set_visible} from "./inbox_util.ts";
import * as keydown_util from "./keydown_util.ts";
import * as left_sidebar_navigation_area from "./left_sidebar_navigation_area.ts";
import {localstorage} from "./localstorage.ts";
import * as message_store from "./message_store.ts";
import type {Message} from "./message_store.ts";
import * as onboarding_steps from "./onboarding_steps.ts";
import * as people from "./people.ts";
import * as stream_color from "./stream_color.ts";
import * as stream_data from "./stream_data.ts";
import * as sub_store from "./sub_store.ts";
import * as unread from "./unread.ts";
import * as unread_ops from "./unread_ops.ts";
import {user_settings} from "./user_settings.ts";
import * as user_status from "./user_status.ts";
import * as user_topics from "./user_topics.ts";
import * as user_topics_ui from "./user_topics_ui.ts";
import * as util from "./util.ts";
import * as views_util from "./views_util.ts";

type DirectMessageContext = {
    conversation_key: string;
    is_direct: boolean;
    rendered_dm_with: string;
    is_group: boolean;
    user_circle_class: string | false | undefined;
    is_bot: boolean;
    dm_url: string;
    user_ids_string: string;
    unread_count: number;
    is_hidden: boolean;
    is_collapsed: boolean;
    latest_msg_id: number;
    column_indexes: typeof COLUMNS;
};

const direct_message_context_properties: (keyof DirectMessageContext)[] = [
    "conversation_key",
    "is_direct",
    "rendered_dm_with",
    "is_group",
    "user_circle_class",
    "is_bot",
    "dm_url",
    "user_ids_string",
    "unread_count",
    "is_hidden",
    "is_collapsed",
    "latest_msg_id",
    "column_indexes",
];

type StreamContext = {
    is_stream: boolean;
    is_archived: boolean;
    invite_only: boolean;
    is_web_public: boolean;
    stream_name: string;
    pin_to_top: boolean;
    is_muted: boolean;
    stream_color: string;
    stream_header_color: string;
    stream_url: string;
    stream_id: number;
    is_hidden: boolean;
    is_collapsed: boolean;
    mention_in_unread: boolean;
    unread_count?: number;
    column_indexes: typeof COLUMNS;
};

const stream_context_properties: (keyof StreamContext)[] = [
    "is_stream",
    "invite_only",
    "is_web_public",
    "stream_name",
    "pin_to_top",
    "is_muted",
    "stream_color",
    "stream_header_color",
    "stream_url",
    "stream_id",
    "is_hidden",
    "is_collapsed",
    "mention_in_unread",
    "unread_count",
    "column_indexes",
];

type TopicContext = {
    is_topic: boolean;
    stream_id: number;
    topic_name: string;
    unread_count: number;
    conversation_key: string;
    topic_url: string;
    is_hidden: boolean;
    is_collapsed: boolean;
    mention_in_unread: boolean;
    latest_msg_id: number;
    all_visibility_policies: typeof user_topics.all_visibility_policies;
    visibility_policy: number | false;
    column_indexes: typeof COLUMNS;
};

const topic_context_properties: (keyof TopicContext)[] = [
    "is_topic",
    "stream_id",
    "topic_name",
    "unread_count",
    "conversation_key",
    "topic_url",
    "is_hidden",
    "is_collapsed",
    "mention_in_unread",
    "latest_msg_id",
    "all_visibility_policies",
    "visibility_policy",
    "column_indexes",
];

let dms_dict = new Map<string, DirectMessageContext>();
let topics_dict = new Map<string, Map<string, TopicContext>>();
let streams_dict = new Map<string, StreamContext>();
let update_triggered_by_user = false;
let filters_dropdown_widget;

const COLUMNS = {
    COLLAPSE_BUTTON: 0,
    RECIPIENT: 1,
    UNREAD_COUNT: 2,
    TOPIC_VISIBILITY: 3,
    ACTION_MENU: 4,
};
let col_focus = COLUMNS.COLLAPSE_BUTTON;
let row_focus = 0;

const ls_filter_key = "inbox-filters";
const ls_collapsed_containers_key = "inbox_collapsed_containers";

const ls = localstorage();
let filters = new Set([views_util.FILTERS.UNMUTED_TOPICS]);
let collapsed_containers = new Set<string>();

let search_keyword = "";
const INBOX_SEARCH_ID = "inbox-search";
const INBOX_FILTERS_DROPDOWN_ID = "inbox-filter_widget";
export let current_focus_id: string | undefined;

const STREAM_HEADER_PREFIX = "inbox-stream-header-";
const CONVERSATION_ID_PREFIX = "inbox-row-conversation-";

const LEFT_NAVIGATION_KEYS = ["left_arrow", "vim_left"];
const RIGHT_NAVIGATION_KEYS = ["right_arrow", "vim_right"];

function get_row_from_conversation_key(key: string): JQuery {
    return $(`#${CSS.escape(CONVERSATION_ID_PREFIX + key)}`);
}

function save_data_to_ls(): void {
    ls.set(ls_filter_key, [...filters]);
    ls.set(ls_collapsed_containers_key, [...collapsed_containers]);
}

export function show(): void {
    // Avoid setting col_focus to recipient when moving to inbox from other narrows.
    // We prefer to focus entire row instead of stream name for inbox-header.
    // Since inbox-row doesn't has a collapse button, focus on COLUMNS.COLLAPSE_BUTTON
    // is same as focus on COLUMNS.RECIPIENT. See `set_list_focus` for details.
    if (col_focus === COLUMNS.RECIPIENT) {
        col_focus = COLUMNS.COLLAPSE_BUTTON;
    }

    views_util.show({
        highlight_view_in_left_sidebar: left_sidebar_navigation_area.highlight_inbox_view,
        $view: $("#inbox-view"),
        update_compose: compose_closed_ui.update_buttons_for_non_specific_views,
        is_visible,
        set_visible,
        complete_rerender,
    });

    if (onboarding_steps.ONE_TIME_NOTICES_TO_DISPLAY.has("intro_inbox_view_modal")) {
        const html_body = render_introduce_zulip_view_modal({
            zulip_view: "inbox",
            current_home_view_and_escape_navigation_enabled:
                user_settings.web_home_view === "inbox" &&
                user_settings.web_escape_navigates_to_home_view,
        });
        dialog_widget.launch({
            html_heading: $t_html({defaultMessage: "Welcome to your <b>inbox</b>!"}),
            html_body,
            html_submit_button: $t_html({defaultMessage: "Got it"}),
            on_click() {
                // Do nothing
            },
            on_hidden() {
                revive_current_focus();
            },
            single_footer_button: true,
            focus_submit_on_open: true,
        });
        onboarding_steps.post_onboarding_step_as_read("intro_inbox_view_modal");
    }
}

export function hide(): void {
    views_util.hide({
        $view: $("#inbox-view"),
        set_visible,
    });
}

function get_topic_key(stream_id: number, topic: string): string {
    return stream_id + ":" + topic;
}

function get_stream_key(stream_id: number): string {
    return "stream_" + stream_id;
}

function get_stream_container(stream_key: string): JQuery {
    return $(`#${CSS.escape(stream_key)}`);
}

function get_topics_container(stream_id: number): JQuery {
    const $topics_container = get_stream_header_row(stream_id)
        .next(".inbox-topic-container")
        .expectOne();
    return $topics_container;
}

function get_stream_header_row(stream_id: number): JQuery {
    const $stream_header_row = $(`#${CSS.escape(STREAM_HEADER_PREFIX + stream_id)}`);
    return $stream_header_row;
}

function load_data_from_ls(): void {
    const saved_filters = new Set(z.array(z.string()).optional().parse(ls.get(ls_filter_key)));
    const valid_filters = new Set(Object.values(views_util.FILTERS));
    // If saved filters are not in the list of valid filters, we reset to default.
    const is_subset = [...saved_filters].every((filter) => valid_filters.has(filter));
    if (saved_filters.size === 0 || !is_subset) {
        filters = new Set([views_util.FILTERS.UNMUTED_TOPICS]);
    } else {
        filters = saved_filters;
    }
    collapsed_containers = new Set(
        z.array(z.string()).optional().parse(ls.get(ls_collapsed_containers_key)),
    );
}

function format_dm(
    user_ids_string: string,
    unread_count: number,
    latest_msg_id: number,
): DirectMessageContext {
    const recipient_ids = people.user_ids_string_to_ids_array(user_ids_string);
    if (recipient_ids.length === 0) {
        // Self DM
        recipient_ids.push(people.my_current_user_id());
    }

    const reply_to = people.user_ids_string_to_emails_string(user_ids_string);
    assert(reply_to !== undefined);
    const rendered_dm_with = recipient_ids
        .map((recipient_id) => ({
            name: people.get_display_full_name(recipient_id),
            status_emoji_info: user_status.get_status_emoji(recipient_id),
        }))
        .sort((a, b) => util.strcmp(a.name, b.name))
        .map((user_info) => render_user_with_status_icon(user_info));

    let user_circle_class: string | false | undefined;
    let is_bot = false;
    if (recipient_ids.length === 1 && recipient_ids[0] !== undefined) {
        is_bot = people.get_by_user_id(recipient_ids[0]).is_bot;
        user_circle_class = is_bot ? false : buddy_data.get_user_circle_class(recipient_ids[0]);
    }

    const context = {
        conversation_key: user_ids_string,
        is_direct: true,
        rendered_dm_with: util.format_array_as_list(rendered_dm_with, "long", "conjunction"),
        is_group: recipient_ids.length > 1,
        user_circle_class,
        is_bot,
        dm_url: hash_util.pm_with_url(reply_to),
        user_ids_string,
        unread_count,
        is_hidden: filter_should_hide_dm_row({dm_key: user_ids_string}),
        is_collapsed: collapsed_containers.has("inbox-dm-header"),
        latest_msg_id,
        column_indexes: COLUMNS,
    };

    return context;
}

function insert_dms(keys_to_insert: string[]): void {
    const sorted_keys = [...dms_dict.keys()];
    // If we need to insert at the top, we do it separately to avoid edge case in loop below.
    if (sorted_keys[0] !== undefined && keys_to_insert.includes(sorted_keys[0])) {
        $("#inbox-direct-messages-container").prepend(
            $(render_inbox_row(dms_dict.get(sorted_keys[0]))),
        );
    }

    for (const [i, key] of sorted_keys.entries()) {
        if (i === 0) {
            continue;
        }

        if (keys_to_insert.includes(key)) {
            const $previous_row = get_row_from_conversation_key(sorted_keys[i - 1]!);
            $previous_row.after($(render_inbox_row(dms_dict.get(key))));
        }
    }
}

function rerender_dm_inbox_row_if_needed(
    new_dm_data: DirectMessageContext,
    old_dm_data: DirectMessageContext | undefined,
    dm_keys_to_insert: string[],
): void {
    if (old_dm_data === undefined) {
        // This row is not rendered yet.
        dm_keys_to_insert.push(new_dm_data.conversation_key);
        return;
    }

    if (old_dm_data.latest_msg_id !== new_dm_data.latest_msg_id) {
        // Row's index likely changed in list, so remove it and insert again.
        get_row_from_conversation_key(new_dm_data.conversation_key).remove();
        dm_keys_to_insert.push(new_dm_data.conversation_key);
        return;
    }

    // If row's latest_msg_id didn't change, we can inplace rerender it, if needed.
    for (const property of direct_message_context_properties) {
        if (new_dm_data[property] !== old_dm_data[property]) {
            const $rendered_row = get_row_from_conversation_key(new_dm_data.conversation_key);
            $rendered_row.replaceWith($(render_inbox_row(new_dm_data)));
            return;
        }
    }
}

function format_stream(stream_id: number): StreamContext {
    // NOTE: Unread count is not included in this function as it is more
    // efficient for the callers to calculate it based on filters.
    const stream_info = sub_store.get(stream_id);
    assert(stream_info !== undefined);

    return {
        is_stream: true,
        is_archived: stream_info.is_archived,
        invite_only: stream_info.invite_only,
        is_web_public: stream_info.is_web_public,
        stream_name: stream_info.name,
        pin_to_top: stream_info.pin_to_top,
        is_muted: stream_info.is_muted,
        stream_color: stream_color.get_stream_privacy_icon_color(stream_info.color),
        stream_header_color: stream_color.get_recipient_bar_color(stream_info.color),
        stream_url: hash_util.by_stream_url(stream_id),
        stream_id,
        // Will be displayed if any topic is visible.
        is_hidden: true,
        is_collapsed: collapsed_containers.has(STREAM_HEADER_PREFIX + stream_id),
        mention_in_unread: unread.stream_has_any_unread_mentions(stream_id),
        column_indexes: COLUMNS,
    };
}

function update_stream_data(
    stream_id: number,
    stream_key: string,
    topic_dict: Map<string, {topic_count: number; latest_msg_id: number}>,
): void {
    const stream_topics_data = new Map<string, TopicContext>();
    const stream_data = format_stream(stream_id);
    let stream_post_filter_unread_count = 0;
    for (const [topic, {topic_count, latest_msg_id}] of topic_dict) {
        const topic_key = get_topic_key(stream_id, topic);
        if (topic_count) {
            const topic_data = format_topic(stream_id, topic, topic_count, latest_msg_id);
            stream_topics_data.set(topic_key, topic_data);
            if (!topic_data.is_hidden) {
                stream_post_filter_unread_count += topic_data.unread_count;
            }
        }
    }
    topics_dict.set(stream_key, get_sorted_row_dict(stream_topics_data));
    stream_data.is_hidden = stream_post_filter_unread_count === 0;
    stream_data.unread_count = stream_post_filter_unread_count;
    streams_dict.set(stream_key, stream_data);
}

function rerender_stream_inbox_header_if_needed(
    new_stream_data: StreamContext,
    old_stream_data: StreamContext,
): void {
    for (const property of stream_context_properties) {
        if (new_stream_data[property] !== old_stream_data[property]) {
            const $rendered_row = get_stream_header_row(new_stream_data.stream_id);
            $rendered_row.replaceWith($(render_inbox_row(new_stream_data)));
            return;
        }
    }
}

function format_topic(
    stream_id: number,
    topic: string,
    topic_unread_count: number,
    latest_msg_id: number,
): TopicContext {
    const context = {
        is_topic: true,
        stream_id,
        topic_name: topic,
        unread_count: topic_unread_count,
        conversation_key: get_topic_key(stream_id, topic),
        topic_url: hash_util.by_stream_topic_url(stream_id, topic),
        is_hidden: filter_should_hide_stream_row({stream_id, topic}),
        is_collapsed: collapsed_containers.has(STREAM_HEADER_PREFIX + stream_id),
        mention_in_unread: unread.topic_has_any_unread_mentions(stream_id, topic),
        latest_msg_id,
        // The 'all_visibility_policies' field is not specific to this context,
        // but this is the easiest way we've figured out for passing the data
        // to the template rendering.
        all_visibility_policies: user_topics.all_visibility_policies,
        visibility_policy: user_topics.get_topic_visibility_policy(stream_id, topic),
        column_indexes: COLUMNS,
    };

    return context;
}

function insert_stream(
    stream_id: number,
    topic_dict: Map<string, {topic_count: number; latest_msg_id: number}>,
): boolean {
    const stream_key = get_stream_key(stream_id);
    update_stream_data(stream_id, stream_key, topic_dict);
    const sorted_stream_keys = get_sorted_stream_keys();
    const stream_index = sorted_stream_keys.indexOf(stream_key);
    const rendered_stream = render_inbox_stream_container({
        topics_dict: new Map([[stream_key, topics_dict.get(stream_key)]]),
        streams_dict,
    });

    if (stream_index === 0) {
        $("#inbox-streams-container").prepend($(rendered_stream));
    } else {
        const previous_stream_key = sorted_stream_keys[stream_index - 1]!;
        $(rendered_stream).insertAfter(get_stream_container(previous_stream_key));
    }
    return !streams_dict.get(stream_key)!.is_hidden;
}

function insert_topics(keys: string[], stream_key: string): void {
    const stream_topics_data = topics_dict.get(stream_key);
    assert(stream_topics_data !== undefined);
    const sorted_keys = [...stream_topics_data.keys()];
    // If we need to insert at the top, we do it separately to avoid edge case in loop below.
    if (sorted_keys[0] !== undefined && keys.includes(sorted_keys[0])) {
        const $stream = get_stream_container(stream_key);
        $stream
            .find(".inbox-topic-container")
            .prepend($(render_inbox_row(stream_topics_data.get(sorted_keys[0]))));
    }

    for (const [i, key] of sorted_keys.entries()) {
        if (i === 0) {
            continue;
        }

        if (keys.includes(key)) {
            const $previous_row = get_row_from_conversation_key(sorted_keys[i - 1]!);
            $previous_row.after($(render_inbox_row(stream_topics_data.get(key))));
        }
    }
}

function rerender_topic_inbox_row_if_needed(
    new_topic_data: TopicContext,
    old_topic_data: TopicContext | undefined,
    topic_keys_to_insert: string[],
): void {
    if (old_topic_data === undefined) {
        // This row is not rendered yet.
        topic_keys_to_insert.push(new_topic_data.conversation_key);
        return;
    }

    if (old_topic_data.latest_msg_id !== new_topic_data.latest_msg_id) {
        // Row's index likely changed in list, so remove it and insert again.
        get_row_from_conversation_key(new_topic_data.conversation_key).remove();
        topic_keys_to_insert.push(new_topic_data.conversation_key);
    }

    for (const property of topic_context_properties) {
        if (new_topic_data[property] !== old_topic_data[property]) {
            const $rendered_row = get_row_from_conversation_key(new_topic_data.conversation_key);
            $rendered_row.replaceWith($(render_inbox_row(new_topic_data)));
            return;
        }
    }
}

function get_sorted_stream_keys(): string[] {
    function compare_function(a: string, b: string): number {
        const stream_a = streams_dict.get(a);
        const stream_b = streams_dict.get(b);
        assert(stream_a !== undefined && stream_b !== undefined);

        // If one of the streams is pinned, they are sorted higher.
        if (stream_a.pin_to_top && !stream_b.pin_to_top) {
            return -1;
        }

        if (stream_b.pin_to_top && !stream_a.pin_to_top) {
            return 1;
        }

        // The muted stream is sorted lower.
        // (Both stream are either pinned or not pinned right now)
        if (stream_a.is_muted && !stream_b.is_muted) {
            return 1;
        }

        if (stream_b.is_muted && !stream_a.is_muted) {
            return -1;
        }

        const stream_name_a = stream_a ? stream_a.stream_name : "";
        const stream_name_b = stream_b ? stream_b.stream_name : "";
        return util.strcmp(stream_name_a, stream_name_b);
    }

    return [...topics_dict.keys()].sort(compare_function);
}

function get_sorted_stream_topic_dict(): Map<string, Map<string, TopicContext>> {
    const sorted_stream_keys = get_sorted_stream_keys();
    const sorted_topic_dict = new Map<string, Map<string, TopicContext>>();
    for (const sorted_stream_key of sorted_stream_keys) {
        sorted_topic_dict.set(sorted_stream_key, topics_dict.get(sorted_stream_key)!);
    }

    return sorted_topic_dict;
}

function get_sorted_row_dict<T extends DirectMessageContext | TopicContext>(
    row_dict: Map<string, T>,
): Map<string, T> {
    return new Map([...row_dict].sort(([, a], [, b]) => b.latest_msg_id - a.latest_msg_id));
}

function reset_data(): {
    unread_dms_count: number;
    is_dms_collapsed: boolean;
    has_dms_post_filter: boolean;
    has_visible_unreads: boolean;
} {
    dms_dict = new Map();
    topics_dict = new Map();
    streams_dict = new Map();

    const unread_dms = unread.get_unread_pm();
    const unread_dms_count = unread_dms.total_count;
    const unread_dms_dict = unread_dms.pm_dict;

    const unread_stream_message = unread.get_unread_topics();
    const unread_stream_msg_count = unread_stream_message.stream_unread_messages;
    const unread_streams_dict = unread_stream_message.topic_counts;

    let has_dms_post_filter = false;
    if (unread_dms_count) {
        for (const [key, {count, latest_msg_id}] of unread_dms_dict) {
            if (count) {
                const dm_data = format_dm(key, count, latest_msg_id);
                dms_dict.set(key, dm_data);
                if (!dm_data.is_hidden) {
                    has_dms_post_filter = true;
                }
            }
        }
    }
    dms_dict = get_sorted_row_dict(dms_dict);

    let has_topics_post_filter = false;
    if (unread_stream_msg_count) {
        for (const [stream_id, topic_dict] of unread_streams_dict) {
            const stream_unread = unread.unread_count_info_for_stream(stream_id);
            const stream_unread_count = stream_unread.unmuted_count + stream_unread.muted_count;
            const stream_key = get_stream_key(stream_id);
            if (stream_unread_count > 0) {
                update_stream_data(stream_id, stream_key, topic_dict);
                if (!streams_dict.get(stream_key)!.is_hidden) {
                    has_topics_post_filter = true;
                }
            } else {
                topics_dict.delete(stream_key);
            }
        }
    }

    const has_visible_unreads = has_dms_post_filter || has_topics_post_filter;
    topics_dict = get_sorted_stream_topic_dict();
    const is_dms_collapsed = collapsed_containers.has("inbox-dm-header");

    return {
        unread_dms_count,
        is_dms_collapsed,
        has_dms_post_filter,
        has_visible_unreads,
    };
}

function show_empty_inbox_text(has_visible_unreads: boolean): void {
    if (!has_visible_unreads) {
        $("#inbox-list").css("border-width", 0);
        if (search_keyword) {
            $("#inbox-empty-with-search").show();
            $("#inbox-empty-without-search").hide();
        } else {
            $("#inbox-empty-with-search").hide();
            // Use display value specified in CSS.
            $("#inbox-empty-without-search").css("display", "");
        }
    } else {
        $(".inbox-empty-text").hide();
        $("#inbox-list").css("border-width", "1px");
    }
}

function filter_click_handler(
    event: JQuery.TriggeredEvent,
    dropdown: tippy.Instance,
    widget: dropdown_widget.DropdownWidget,
): void {
    event.preventDefault();
    event.stopPropagation();

    const filter_id = $(event.currentTarget).attr("data-unique-id");
    assert(filter_id !== undefined);
    // We don't support multiple filters yet, so we clear existing and add the new filter.
    filters = new Set([filter_id]);
    save_data_to_ls();
    dropdown.hide();
    widget.render();
    update();
}

export function complete_rerender(): void {
    if (!is_visible()) {
        return;
    }
    load_data_from_ls();
    const {has_visible_unreads, ...additional_context} = reset_data();
    $("#inbox-pane").html(
        render_inbox_view({
            search_val: search_keyword,
            INBOX_SEARCH_ID,
            dms_dict,
            topics_dict,
            streams_dict,
            ...additional_context,
        }),
    );
    show_empty_inbox_text(has_visible_unreads);
    // If the focus is not on the inbox rows, the inbox view scrolls
    // down when moving from other views to the inbox view. To avoid
    // this, we scroll to top before restoring focus via revive_current_focus.
    $("html").scrollTop(0);
    setTimeout(() => {
        revive_current_focus();
    }, 0);

    const first_filter = filters.values().next();
    filters_dropdown_widget = new dropdown_widget.DropdownWidget({
        ...views_util.COMMON_DROPDOWN_WIDGET_PARAMS,
        widget_name: "inbox-filter",
        item_click_callback: filter_click_handler,
        $events_container: $("#inbox-main"),
        default_id: first_filter.done ? undefined : first_filter.value,
    });
    filters_dropdown_widget.setup();
}

export function search_and_update(): void {
    const new_keyword = $<HTMLInputElement>("input#inbox-search").val() ?? "";
    if (new_keyword === search_keyword) {
        return;
    }
    search_keyword = new_keyword;
    current_focus_id = INBOX_SEARCH_ID;
    update_triggered_by_user = true;
    update();
}

function row_in_search_results(keyword: string, text: string): boolean {
    if (keyword === "") {
        return true;
    }
    const search_words = keyword.toLowerCase().split(/\s+/);
    return search_words.every((word) => text.includes(word));
}

function filter_should_hide_dm_row({dm_key}: {dm_key: string}): boolean {
    const recipients_string = people.get_recipients(dm_key);
    const text = recipients_string.toLowerCase();

    if (!row_in_search_results(search_keyword, text)) {
        return true;
    }

    return false;
}

function filter_should_hide_stream_row({
    stream_id,
    topic,
}: {
    stream_id: number;
    topic: string;
}): boolean {
    const sub = sub_store.get(stream_id);
    if (!sub?.subscribed) {
        return true;
    }

    if (
        filters.has(views_util.FILTERS.FOLLOWED_TOPICS) &&
        !user_topics.is_topic_followed(stream_id, topic)
    ) {
        return true;
    }

    if (
        filters.has(views_util.FILTERS.UNMUTED_TOPICS) &&
        (user_topics.is_topic_muted(stream_id, topic) || stream_data.is_muted(stream_id)) &&
        !user_topics.is_topic_unmuted_or_followed(stream_id, topic)
    ) {
        return true;
    }

    const text = (sub.name + " " + topic).toLowerCase();

    if (!row_in_search_results(search_keyword, text)) {
        return true;
    }

    return false;
}

export function collapse_or_expand(container_id: string): void {
    let $toggle_icon;
    let $container;
    if (container_id === "inbox-dm-header") {
        $container = $(`#inbox-direct-messages-container`);
        $container.children().toggleClass("collapsed_container");
        $toggle_icon = $("#inbox-dm-header .toggle-inbox-header-icon");
    } else {
        const stream_id = Number(container_id.slice(STREAM_HEADER_PREFIX.length));
        $container = get_topics_container(stream_id);
        $container.children().toggleClass("collapsed_container");
        $toggle_icon = $(
            `#${CSS.escape(STREAM_HEADER_PREFIX + stream_id)} .toggle-inbox-header-icon`,
        );
    }
    $toggle_icon.toggleClass("icon-collapsed-state");

    if (collapsed_containers.has(container_id)) {
        collapsed_containers.delete(container_id);
    } else {
        collapsed_containers.add(container_id);
    }

    save_data_to_ls();
}

function focus_current_id(): void {
    assert(current_focus_id !== undefined);
    $(`#${CSS.escape(current_focus_id)}`).trigger("focus");
}

function focus_inbox_search(): void {
    current_focus_id = INBOX_SEARCH_ID;
    focus_current_id();
}

function is_list_focused(): boolean {
    return (
        current_focus_id === undefined ||
        ![INBOX_SEARCH_ID, INBOX_FILTERS_DROPDOWN_ID].includes(current_focus_id)
    );
}

function get_all_rows(): JQuery {
    return $("#inbox-main .inbox-header, #inbox-main .inbox-row").not(
        ".hidden_by_filters, .collapsed_container",
    );
}

function get_row_index($elt: JQuery): number {
    const $all_rows = get_all_rows();
    const $row = $elt.closest(".inbox-row, .inbox-header");
    return $all_rows.index($row);
}

function focus_clicked_list_element($elt: JQuery): void {
    row_focus = get_row_index($elt);
    update_triggered_by_user = true;
}

export function revive_current_focus(): void {
    if (!is_in_focus()) {
        return;
    }
    if (is_list_focused()) {
        set_list_focus();
    } else {
        focus_current_id();
    }
}

function update_closed_compose_text($row: JQuery, is_header_row: boolean): void {
    // TODO: This fake "message" object is designed to allow using the
    // get_recipient_label helper inside compose_closed_ui. Surely
    // there's a more readable way to write this code.
    // Similar code is present in recent view.

    if (is_header_row) {
        compose_closed_ui.set_standard_text_for_reply_button();
        return;
    }

    let message;
    const is_dm = $row.parent("#inbox-direct-messages-container").length > 0;
    if (is_dm) {
        message = {
            display_reply_to: $row.find(".recipients_name").text(),
        };
    } else {
        const $stream = $row.parent(".inbox-topic-container").prev(".inbox-header");
        message = {
            stream_id: Number($stream.attr("data-stream-id")),
            topic: $row.find(".inbox-topic-name a").text(),
        };
    }
    compose_closed_ui.update_reply_recipient_label(message);
}

export function get_focused_row_message(): {message?: Message | undefined} & (
    | {msg_type: "private"; private_message_recipient?: string}
    | {msg_type: "stream"; stream_id: number; topic?: string}
    | {msg_type?: never}
) {
    if (!is_list_focused()) {
        return {message: undefined};
    }

    const $all_rows = get_all_rows();
    const focused_row = $all_rows.get(row_focus);
    assert(focused_row !== undefined);
    const $focused_row = $(focused_row);
    if (is_row_a_header($focused_row)) {
        const is_dm_header = $focused_row.attr("id") === "inbox-dm-header";
        if (is_dm_header) {
            return {message: undefined, msg_type: "private"};
        }

        const stream_id = Number($focused_row.attr("data-stream-id"));
        compose_state.set_compose_recipient_id(stream_id);
        return {message: undefined, msg_type: "stream", stream_id};
    }

    const is_dm = $focused_row.parent("#inbox-direct-messages-container").length > 0;
    const conversation_key = $focused_row.attr("id")!.slice(CONVERSATION_ID_PREFIX.length);

    if (is_dm) {
        const row_info = dms_dict.get(conversation_key);
        assert(row_info !== undefined);
        const message = message_store.get(row_info.latest_msg_id);
        if (message === undefined) {
            const recipients = people.user_ids_string_to_emails_string(row_info.user_ids_string);
            assert(recipients !== undefined);
            return {
                msg_type: "private",
                private_message_recipient: recipients,
            };
        }
        return {message};
    }

    const $stream = $focused_row.parent(".inbox-topic-container").parent();
    const stream_key = $stream.attr("id");
    assert(stream_key !== undefined);
    const row_info = topics_dict.get(stream_key)!.get(conversation_key);
    assert(row_info !== undefined);
    const message = message_store.get(row_info.latest_msg_id);
    // Since inbox is populated based on unread data which is part
    // of /register request, it is possible that we don't have the
    // actual message in our message_store. In that case, we return
    // a fake message object.
    if (message === undefined) {
        return {
            msg_type: "stream",
            stream_id: row_info.stream_id,
            topic: row_info.topic_name,
        };
    }
    return {message};
}

export function toggle_topic_visibility_policy(): boolean {
    const inbox_message = get_focused_row_message();
    if (inbox_message.message !== undefined) {
        user_topics_ui.toggle_topic_visibility_policy(inbox_message.message);
        if (inbox_message.message.type === "stream") {
            // means mute/unmute action is taken
            const $elt = $(".inbox-header"); // Select the element with class "inbox-header"
            const $focusElement = $elt.find(get_focus_class_for_header()).first();
            focus_clicked_list_element($focusElement);
            return true;
        }
    }
    return false;
}

function is_row_a_header($row: JQuery): boolean {
    return $row.hasClass("inbox-header");
}

function set_list_focus(input_key?: string): void {
    // This function is used for both revive_current_focus and
    // setting focus after modify col_focus and row_focus as per
    // hotkey pressed by user.
    //
    // When to focus on entire row?
    // For `inbox-header`, when focus on COLUMNS.COLLAPSE_BUTTON
    // For `inbox-row`, when focus on COLUMNS.COLLAPSE_BUTTON (fake) or COLUMNS.RECIPIENT

    const $all_rows = get_all_rows();
    const max_row_focus = $all_rows.length - 1;
    if (max_row_focus < 0) {
        focus_filters_dropdown();
        return;
    }

    if (row_focus > max_row_focus) {
        row_focus = max_row_focus;
    } else if (row_focus < 0) {
        row_focus = 0;
    }

    const row_to_focus = $all_rows.get(row_focus);
    assert(row_to_focus !== undefined);
    const $row_to_focus = $(row_to_focus);
    // This includes a fake collapse button for `inbox-row` and a fake topic visibility
    // button for `inbox-header`. The fake buttons help simplify code here and
    // `$($cols_to_focus[col_focus]).trigger("focus");` at the end of this function.
    const $cols_to_focus = [$row_to_focus, ...$row_to_focus.find("[tabindex=0]")];
    const total_cols = $cols_to_focus.length;
    current_focus_id = $row_to_focus.attr("id");
    const is_header_row = is_row_a_header($row_to_focus);
    update_closed_compose_text($row_to_focus, is_header_row);

    // Loop through columns.
    if (col_focus > total_cols - 1) {
        col_focus = 0;
    } else if (col_focus < 0) {
        col_focus = total_cols - 1;
    }

    // Since header rows always have a collapse button, other rows have one less element to focus.
    if (col_focus === COLUMNS.COLLAPSE_BUTTON) {
        if (!is_header_row && input_key !== undefined && LEFT_NAVIGATION_KEYS.includes(input_key)) {
            // In `inbox-row` user pressed left on COLUMNS.RECIPIENT, so
            // go to the last column.
            col_focus = total_cols - 1;
        }
    } else if (!is_header_row && col_focus === COLUMNS.RECIPIENT) {
        if (input_key !== undefined && RIGHT_NAVIGATION_KEYS.includes(input_key)) {
            // In `inbox-row` user pressed right on COLUMNS.COLLAPSE_BUTTON.
            // Since `inbox-row` has no collapse button, user wants to go
            // to the unread count button.
            col_focus = COLUMNS.UNREAD_COUNT;
        } else if (input_key !== undefined && LEFT_NAVIGATION_KEYS.includes(input_key)) {
            // In `inbox-row` user pressed left on COLUMNS.UNREAD_COUNT,
            // we move focus to COLUMNS.COLLAPSE_BUTTON so that moving
            // up or down to `inbox-header` keeps the entire row focused for the
            // `inbox-header` too.
            col_focus = COLUMNS.COLLAPSE_BUTTON;
        } else {
            // up / down arrow
            // For `inbox-row`, we focus entire row for COLUMNS.RECIPIENT.
            $row_to_focus.trigger("focus");
            return;
        }
    } else if (is_header_row && col_focus === COLUMNS.TOPIC_VISIBILITY) {
        // `inbox-header` doesn't have a topic visibility indicator, so focus on
        // button around it instead.
        if (input_key !== undefined && LEFT_NAVIGATION_KEYS.includes(input_key)) {
            col_focus = COLUMNS.UNREAD_COUNT;
        } else {
            col_focus = COLUMNS.ACTION_MENU;
        }
    }

    const col_to_focus = $cols_to_focus[col_focus];
    assert(col_to_focus !== undefined);
    $(col_to_focus).trigger("focus");
}

function focus_filters_dropdown(): void {
    current_focus_id = INBOX_FILTERS_DROPDOWN_ID;
    $(`#${CSS.escape(INBOX_FILTERS_DROPDOWN_ID)}`).trigger("focus");
}

function is_search_focused(): boolean {
    return current_focus_id === INBOX_SEARCH_ID;
}

function is_filters_dropdown_focused(): boolean {
    return current_focus_id === INBOX_FILTERS_DROPDOWN_ID;
}

function get_page_up_down_delta(): number {
    const element_above = document.querySelector("#inbox-filters");
    const element_down = document.querySelector("#compose");
    assert(element_above !== null && element_down !== null);
    const visible_top = element_above.getBoundingClientRect().bottom;
    const visible_bottom = element_down.getBoundingClientRect().top;
    // One usually wants PageDown to move what had been the bottom row
    // to now be at the top, so one can be confident one will see
    // every row using it. This offset helps achieve that goal.
    //
    // See navigate.amount_to_paginate for similar logic in the message feed.
    const scrolling_reduction_to_maintain_context = 30;

    const delta = visible_bottom - visible_top - scrolling_reduction_to_maintain_context;
    return delta;
}

function page_up_navigation(): void {
    const delta = get_page_up_down_delta();
    const scroll_element = document.documentElement;
    const new_scrollTop = scroll_element.scrollTop - delta;
    if (new_scrollTop <= 0) {
        row_focus = 0;
    }
    scroll_element.scrollTop = new_scrollTop;
    set_list_focus();
}

function page_down_navigation(): void {
    const delta = get_page_up_down_delta();
    const scroll_element = document.documentElement;
    const new_scrollTop = scroll_element.scrollTop + delta;
    const $all_rows = get_all_rows();
    const $last_row = $all_rows.last();
    const last_row_bottom = ($last_row.offset()?.top ?? 0) + ($last_row.outerHeight() ?? 0);
    // Move focus to last row if it is visible and we are at the bottom.
    if (last_row_bottom <= new_scrollTop) {
        row_focus = get_all_rows().length - 1;
    }
    scroll_element.scrollTop = new_scrollTop;
    set_list_focus();
}

export function change_focused_element(input_key: string): boolean {
    if (input_key === "tab" || input_key === "shift_tab") {
        // Tabbing should be handled by browser but to keep the focus element same
        // when we rerender or user uses other hotkeys, we need to track
        // the current focused element.
        setTimeout(() => {
            const post_tab_focus_elem = document.activeElement;
            if (!(post_tab_focus_elem instanceof HTMLElement)) {
                return;
            }

            if (
                post_tab_focus_elem.id === INBOX_SEARCH_ID ||
                post_tab_focus_elem.id === INBOX_FILTERS_DROPDOWN_ID
            ) {
                current_focus_id = post_tab_focus_elem.id;
            }

            const row_to_focus = post_tab_focus_elem.closest(".inbox-row, .inbox-header");
            if (row_to_focus instanceof HTMLElement) {
                const col_index = $(post_tab_focus_elem)
                    .closest("[tabindex=0]")
                    .attr("data-col-index");
                if (!col_index) {
                    return;
                }

                current_focus_id = row_to_focus.id;
                row_focus = get_row_index($(row_to_focus));
                col_focus = Number.parseInt(col_index, 10);
            }
        }, 0);
        return false;
    }

    if (is_search_focused()) {
        const textInput = $<HTMLInputElement>(`input#${CSS.escape(INBOX_SEARCH_ID)}`).get(0);
        assert(textInput !== undefined);
        const start = textInput.selectionStart ?? 0;
        const end = textInput.selectionEnd ?? 0;
        const text_length = textInput.value.length;
        let is_selected = false;
        if (end - start > 0) {
            is_selected = true;
        }

        switch (input_key) {
            case "down_arrow":
                set_list_focus();
                return true;
            case "right_arrow":
                if (end !== text_length || is_selected) {
                    return false;
                }
                focus_filters_dropdown();
                return true;
            case "left_arrow":
                if (start !== 0 || is_selected) {
                    return false;
                }
                focus_filters_dropdown();
                return true;
            case "escape":
                if (get_all_rows().length === 0) {
                    return false;
                }
                set_list_focus();
                return true;
        }
    } else if (is_filters_dropdown_focused()) {
        switch (input_key) {
            case "vim_down":
            case "down_arrow":
                set_list_focus();
                return true;
            case "vim_left":
            case "left_arrow":
                focus_inbox_search();
                return true;
            case "vim_right":
            case "right_arrow":
                focus_inbox_search();
                return true;
            case "escape":
                if (get_all_rows().length === 0) {
                    return false;
                }
                set_list_focus();
                return true;
        }
    } else {
        switch (input_key) {
            case "vim_down":
            case "down_arrow":
                row_focus += 1;
                set_list_focus();
                center_focus_if_offscreen();
                return true;
            case "vim_up":
            case "up_arrow":
                if (row_focus === 0) {
                    focus_filters_dropdown();
                    return true;
                }
                row_focus -= 1;
                set_list_focus();
                center_focus_if_offscreen();
                return true;
            case RIGHT_NAVIGATION_KEYS[0]:
            case RIGHT_NAVIGATION_KEYS[1]:
                col_focus += 1;
                set_list_focus(input_key);
                return true;
            case LEFT_NAVIGATION_KEYS[0]:
            case LEFT_NAVIGATION_KEYS[1]:
                col_focus -= 1;
                set_list_focus(input_key);
                return true;
            case "page_up":
                page_up_navigation();
                return true;
            case "page_down":
                page_down_navigation();
                return true;
        }
    }

    return false;
}

export function update(): void {
    if (!is_visible()) {
        return;
    }

    const unread_dms = unread.get_unread_pm();
    const unread_dms_count = unread_dms.total_count;
    const unread_dms_dict = unread_dms.pm_dict;

    const unread_stream_message = unread.get_unread_topics();
    const unread_streams_dict = unread_stream_message.topic_counts;

    let has_dms_post_filter = false;
    const dm_keys_to_insert: string[] = [];
    for (const [key, {count, latest_msg_id}] of unread_dms_dict) {
        if (count !== 0) {
            const old_dm_data = dms_dict.get(key);
            const new_dm_data = format_dm(key, count, latest_msg_id);
            rerender_dm_inbox_row_if_needed(new_dm_data, old_dm_data, dm_keys_to_insert);
            dms_dict.set(key, new_dm_data);
            if (!new_dm_data.is_hidden) {
                has_dms_post_filter = true;
            }
        } else {
            // If it is rendered.
            if (dms_dict.get(key) !== undefined) {
                dms_dict.delete(key);
                get_row_from_conversation_key(key).remove();
            }
        }
    }

    dms_dict = get_sorted_row_dict(dms_dict);
    insert_dms(dm_keys_to_insert);

    const $inbox_dm_header = $("#inbox-dm-header");
    if (!has_dms_post_filter) {
        $inbox_dm_header.addClass("hidden_by_filters");
    } else {
        $inbox_dm_header.removeClass("hidden_by_filters");
        $inbox_dm_header.find(".unread_count").text(unread_dms_count);
    }

    let has_topics_post_filter = false;
    for (const [stream_id, topic_dict] of unread_streams_dict) {
        const stream_unread = unread.unread_count_info_for_stream(stream_id);
        const stream_unread_count = stream_unread.unmuted_count + stream_unread.muted_count;
        const stream_key = get_stream_key(stream_id);
        let stream_post_filter_unread_count = 0;
        if (stream_unread_count > 0) {
            const stream_topics_data = topics_dict.get(stream_key);

            // Stream isn't rendered.
            if (stream_topics_data === undefined) {
                const is_stream_visible = insert_stream(stream_id, topic_dict);
                if (is_stream_visible) {
                    has_topics_post_filter = true;
                }
                continue;
            }

            const topic_keys_to_insert: string[] = [];
            const new_stream_data = format_stream(stream_id);
            for (const [topic, {topic_count, latest_msg_id}] of topic_dict) {
                const topic_key = get_topic_key(stream_id, topic);
                if (topic_count) {
                    const old_topic_data = stream_topics_data.get(topic_key);
                    const new_topic_data = format_topic(
                        stream_id,
                        topic,
                        topic_count,
                        latest_msg_id,
                    );
                    stream_topics_data.set(topic_key, new_topic_data);
                    rerender_topic_inbox_row_if_needed(
                        new_topic_data,
                        old_topic_data,
                        topic_keys_to_insert,
                    );
                    if (!new_topic_data.is_hidden) {
                        has_topics_post_filter = true;
                        stream_post_filter_unread_count += new_topic_data.unread_count;
                    }
                } else {
                    // Remove old topic data since it can act as false data for renamed / a new
                    // topic having the same name as old topic.
                    stream_topics_data.delete(topic_key);
                    get_row_from_conversation_key(topic_key).remove();
                }
            }
            const old_stream_data = streams_dict.get(stream_key);
            assert(old_stream_data !== undefined);
            new_stream_data.is_hidden = stream_post_filter_unread_count === 0;
            new_stream_data.unread_count = stream_post_filter_unread_count;
            streams_dict.set(stream_key, new_stream_data);
            rerender_stream_inbox_header_if_needed(new_stream_data, old_stream_data);
            topics_dict.set(stream_key, get_sorted_row_dict(stream_topics_data));
            insert_topics(topic_keys_to_insert, stream_key);
        } else {
            topics_dict.delete(stream_key);
            streams_dict.delete(stream_key);
            get_stream_container(stream_key).remove();
        }
    }

    const has_visible_unreads = has_dms_post_filter || has_topics_post_filter;
    show_empty_inbox_text(has_visible_unreads);

    // We want to avoid weird jumps when user is interacting with Inbox
    // and we are updating the view. So, we only reset current focus if
    // the update was triggered by user. This can mean `row_focus` can
    // be out of bounds, so we need to fix that.
    if (update_triggered_by_user) {
        setTimeout(revive_current_focus, 0);
        update_triggered_by_user = false;
    } else {
        if (row_focus >= get_all_rows().length) {
            revive_current_focus();
        }
    }
}

function get_focus_class_for_header(): string {
    let focus_class = ".collapsible-button";

    switch (col_focus) {
        case COLUMNS.RECIPIENT: {
            focus_class = ".inbox-header-name a";
            break;
        }
        case COLUMNS.UNREAD_COUNT: {
            focus_class = ".unread_count";
            break;
        }
        case COLUMNS.ACTION_MENU: {
            focus_class = ".inbox-stream-menu";
        }
    }

    return focus_class;
}

function get_focus_class_for_row(): string {
    let focus_class = ".inbox-left-part";
    switch (col_focus) {
        case COLUMNS.UNREAD_COUNT: {
            focus_class = ".unread_count";
            break;
        }
        case COLUMNS.ACTION_MENU: {
            focus_class = ".inbox-topic-menu";
            break;
        }
        case COLUMNS.TOPIC_VISIBILITY: {
            focus_class = ".change_visibility_policy";
            break;
        }
    }
    return focus_class;
}

function is_element_visible(element_position: DOMRect): boolean {
    const element_above = document.querySelector("#inbox-filters");
    const element_down = document.querySelector("#compose");
    assert(element_above !== null && element_down !== null);
    const visible_top = element_above.getBoundingClientRect().bottom;
    const visible_bottom = element_down.getBoundingClientRect().top;

    if (element_position.top >= visible_top && element_position.bottom <= visible_bottom) {
        return true;
    }
    return false;
}

function center_focus_if_offscreen(): void {
    // Move focused to row to visible area so to avoid
    // it being under compose box or inbox filters.
    const $elt = $(".inbox-row:focus, .inbox-header:focus");
    if ($elt[0] === undefined) {
        return;
    }

    const elt_pos = $elt[0].getBoundingClientRect();
    if (is_element_visible(elt_pos)) {
        // Element is visible.
        return;
    }

    // Scroll element into center if offscreen.
    $elt[0].scrollIntoView({block: "center"});
}

function move_focus_to_visible_area(): void {
    // Focus on the row below inbox filters if the focused
    // row is not visible.
    if (!is_visible() || !is_list_focused()) {
        return;
    }

    const $all_rows = get_all_rows();
    if ($all_rows.length <= 3) {
        // No need to process anything if there are only a few rows.
        return;
    }

    let row = $all_rows[row_focus];
    if (row === undefined) {
        row_focus = $all_rows.length - 1;
        row = $all_rows[row_focus];
        assert(row !== undefined);
        revive_current_focus();
    }

    const elt_pos = row.getBoundingClientRect();
    if (is_element_visible(elt_pos)) {
        return;
    }

    const INBOX_ROW_HEIGHT = 30;
    const position = util.the($("#inbox-filters")).getBoundingClientRect();
    const inbox_center_x = (position.left + position.right) / 2;
    // We are aiming to get the first row if it is completely visible or the second row.
    const inbox_row_below_filters = position.bottom + INBOX_ROW_HEIGHT;
    const element_in_row = document.elementFromPoint(inbox_center_x, inbox_row_below_filters);
    if (!element_in_row) {
        // `element_in_row` can be `null` according to MDN if:
        // "If the specified point is outside the visible bounds of the document or
        // either coordinate is negative, the result is null."
        // https://developer.mozilla.org/en-US/docs/Web/API/Document/elementFromPoint
        // This means by the time we reached here user has already scrolled past the
        // row and it is no longer visible. So, we just return and let the next call
        // to `move_focus_to_visible_area` handle it.
        return;
    }

    const $element_in_row = $(element_in_row);

    let $inbox_row = $element_in_row.closest(".inbox-row");
    if ($inbox_row.length === 0) {
        $inbox_row = $element_in_row.closest(".inbox-header");
    }

    row_focus = $all_rows.index($inbox_row.get(0));
    revive_current_focus();
}

export function is_in_focus(): boolean {
    return is_visible() && views_util.is_in_focus();
}

export function initialize(): void {
    $(document).on(
        "scroll",
        _.throttle(() => {
            move_focus_to_visible_area();
        }, 50),
    );

    $("body").on(
        "keyup",
        "#inbox-search",
        _.debounce(() => {
            search_and_update();
        }, 300),
    );

    $("body").on("keydown", ".inbox-header", (e) => {
        if (e.metaKey || e.ctrlKey) {
            return;
        }

        if (keydown_util.is_enter_event(e)) {
            e.preventDefault();
            e.stopPropagation();

            const $elt = $(e.currentTarget);
            $elt.find(get_focus_class_for_header()).trigger("click");
        }
    });

    $("body").on(
        "click",
        "#inbox-list .inbox-header .collapsible-button",
        function (this: HTMLElement, e) {
            const $elt = $(this);
            const container_id = $elt.parents(".inbox-header").attr("id");
            assert(container_id !== undefined);
            col_focus = COLUMNS.COLLAPSE_BUTTON;
            focus_clicked_list_element($elt);
            collapse_or_expand(container_id);
            e.stopPropagation();
        },
    );

    $("body").on("keydown", ".inbox-row", (e) => {
        if (e.metaKey || e.ctrlKey) {
            return;
        }

        if (keydown_util.is_enter_event(e)) {
            e.preventDefault();
            e.stopPropagation();

            const $elt = $(e.currentTarget);
            $elt.find(get_focus_class_for_row()).trigger("click");
        }
    });

    $("body").on("click", "#inbox-list .inbox-left-part-wrapper", function (this: HTMLElement, e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
            return;
        }

        const $elt = $(this);
        col_focus = COLUMNS.RECIPIENT;
        focus_clicked_list_element($elt);
        const href = $elt.find("a").attr("href");
        assert(href !== undefined);
        window.location.href = href;
    });

    $("body").on("click", "#inbox-list .on_hover_dm_read", function (this: HTMLElement, e) {
        e.stopPropagation();
        e.preventDefault();
        const $elt = $(this);
        col_focus = COLUMNS.UNREAD_COUNT;
        focus_clicked_list_element($elt);
        const user_ids_string = $elt.attr("data-user-ids-string");
        if (user_ids_string) {
            // direct message row
            unread_ops.mark_pm_as_read(user_ids_string);
        }
    });

    $("body").on("click", "#inbox-list .on_hover_all_dms_read", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const unread_dms_msg_ids = unread.get_msg_ids_for_private();
        const unread_dms_messages = unread_dms_msg_ids.map((msg_id) => {
            const message = message_store.get(msg_id);
            assert(message !== undefined);
            return message;
        });
        unread_ops.notify_server_messages_read(unread_dms_messages);
        focus_inbox_search();
        update_triggered_by_user = true;
    });

    $("body").on("click", "#inbox-list .on_hover_topic_read", function (this: HTMLElement, e) {
        e.stopPropagation();
        e.preventDefault();
        const $elt = $(this);
        col_focus = COLUMNS.UNREAD_COUNT;
        focus_clicked_list_element($elt);
        const user_ids_string = $elt.attr("data-user-ids-string");
        if (user_ids_string) {
            // direct message row
            unread_ops.mark_pm_as_read(user_ids_string);
            return;
        }
        const stream_id = Number($elt.attr("data-stream-id"));
        const topic = $elt.attr("data-topic-name");
        if (topic) {
            unread_ops.mark_topic_as_read(stream_id, topic);
        } else {
            unread_ops.mark_stream_as_read(stream_id);
        }
    });

    $("body").on("click", "#inbox-list .change_visibility_policy", function (this: HTMLElement) {
        const $elt = $(this);
        col_focus = COLUMNS.TOPIC_VISIBILITY;
        focus_clicked_list_element($elt);
    });

    $("body").on("click", "#inbox-clear-search", () => {
        $("#inbox-search").val("");
        search_and_update();
        focus_inbox_search();
    });

    $("body").on("click", "#inbox-search", () => {
        current_focus_id = INBOX_SEARCH_ID;
        compose_closed_ui.set_standard_text_for_reply_button();
    });

    $(document).on("compose_canceled.zulip", () => {
        if (is_visible()) {
            revive_current_focus();
        }
    });
}
