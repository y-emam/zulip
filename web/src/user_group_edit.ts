import $ from "jquery";
import assert from "minimalistic-assert";
import type * as tippy from "tippy.js";
import {z} from "zod";

import render_confirm_delete_user from "../templates/confirm_dialog/confirm_delete_user.hbs";
import render_confirm_join_group_direct_member from "../templates/confirm_dialog/confirm_join_group_direct_member.hbs";
import render_group_info_banner from "../templates/modal_banner/user_group_info_banner.hbs";
import render_browse_user_groups_list_item from "../templates/user_group_settings/browse_user_groups_list_item.hbs";
import render_cannot_deactivate_group_banner from "../templates/user_group_settings/cannot_deactivate_group_banner.hbs";
import render_change_user_group_info_modal from "../templates/user_group_settings/change_user_group_info_modal.hbs";
import render_user_group_membership_status from "../templates/user_group_settings/user_group_membership_status.hbs";
import render_user_group_settings from "../templates/user_group_settings/user_group_settings.hbs";
import render_user_group_settings_overlay from "../templates/user_group_settings/user_group_settings_overlay.hbs";

import * as blueslip from "./blueslip.ts";
import * as browser_history from "./browser_history.ts";
import * as channel from "./channel.ts";
import * as components from "./components.ts";
import type {Toggle} from "./components.ts";
import * as compose_banner from "./compose_banner.ts";
import * as confirm_dialog from "./confirm_dialog.ts";
import * as dialog_widget from "./dialog_widget.ts";
import * as group_permission_settings from "./group_permission_settings.ts";
import * as hash_util from "./hash_util.ts";
import {$t, $t_html} from "./i18n.ts";
import * as ListWidget from "./list_widget.ts";
import * as loading from "./loading.ts";
import * as overlays from "./overlays.ts";
import * as people from "./people.ts";
import * as scroll_util from "./scroll_util.ts";
import type {UserGroupUpdateEvent} from "./server_event_types.ts";
import * as settings_components from "./settings_components.ts";
import * as settings_config from "./settings_config.ts";
import * as settings_data from "./settings_data.ts";
import * as settings_org from "./settings_org.ts";
import {current_user, realm} from "./state_data.ts";
import * as stream_data from "./stream_data.ts";
import * as timerender from "./timerender.ts";
import * as ui_report from "./ui_report.ts";
import * as user_group_components from "./user_group_components.ts";
import * as user_group_create from "./user_group_create.ts";
import * as user_group_edit_members from "./user_group_edit_members.ts";
import * as user_groups from "./user_groups.ts";
import type {UserGroup} from "./user_groups.ts";
import * as user_profile from "./user_profile.ts";
import * as util from "./util.ts";

type ActiveData = {
    $row: JQuery | undefined;
    id: number | undefined;
    $tabs: JQuery;
};

export let toggler: Toggle;
export let select_tab = "general";

let group_list_widget: ListWidget.ListWidget<UserGroup, UserGroup>;
let group_list_toggler: Toggle;

function get_user_group_id(target: HTMLElement): number {
    const $row = $(target).closest(
        ".group-row, .user_group_settings_wrapper, .save-button, .group_settings_header",
    );
    return Number.parseInt($row.attr("data-group-id")!, 10);
}

function get_user_group_for_target(target: HTMLElement): UserGroup | undefined {
    const user_group_id = get_user_group_id(target);
    if (!user_group_id) {
        blueslip.error("Cannot find user group id for target");
        return undefined;
    }

    const group = user_groups.get_user_group_from_id(user_group_id);
    if (!group) {
        blueslip.error("get_user_group_for_target() failed id lookup", {user_group_id});
        return undefined;
    }
    return group;
}

export function get_edit_container(group: UserGroup): JQuery {
    return $(
        `#groups_overlay .user_group_settings_wrapper[data-group-id='${CSS.escape(group.id.toString())}']`,
    );
}

function update_add_members_elements(group: UserGroup): void {
    if (!is_editing_group(group.id)) {
        return;
    }

    // We are only concerned with the Members tab for editing groups.
    const $add_members_container = $<tippy.PopperElement>(
        ".edit_members_for_user_group .add_members_container",
    );

    if (current_user.is_guest || realm.realm_is_zephyr_mirror_realm) {
        // For guest users, we just hide the add_members feature.
        $add_members_container.hide();
        return;
    }

    // Otherwise, we adjust whether the widgets are disabled based on
    // whether this user is authorized to add members.
    const $input_element = $add_members_container.find(".input").expectOne();
    const $button_element = $add_members_container.find('button[name="add_member"]').expectOne();

    if (settings_data.can_add_members_to_user_group(group.id)) {
        $input_element.prop("contenteditable", true);
        if (user_group_edit_members.pill_widget.items().length > 0) {
            $button_element.prop("disabled", false);
        }
        $button_element.css("pointer-events", "");
        $add_members_container[0]?._tippy?.destroy();
        $add_members_container.removeClass("add_members_disabled");
    } else {
        $input_element.prop("contenteditable", false);
        $button_element.prop("disabled", true);
        $add_members_container.addClass("add_members_disabled");

        settings_components.initialize_disable_button_hint_popover(
            $add_members_container,
            $t({defaultMessage: "You are not allowed to add members to this group."}),
        );
    }
}

function update_group_permission_settings_elements(group: UserGroup): void {
    if (!is_editing_group(group.id)) {
        return;
    }

    // We are concerned with the General tab for changing group permissions.
    const $group_permission_settings = $("#group_permission_settings");

    const $permission_pill_container_elements = $group_permission_settings.find(".pill-container");
    const $permission_input_groups = $group_permission_settings.find(".input-group");

    if (settings_data.can_manage_user_group(group.id)) {
        $permission_pill_container_elements.find(".input").prop("contenteditable", true);
        $permission_input_groups.removeClass("group_setting_disabled");

        $permission_input_groups.each(function (this: tippy.ReferenceElement) {
            $(this)[0]?._tippy?.destroy();
        });
        settings_components.enable_opening_typeahead_on_clicking_label($group_permission_settings);
    } else {
        $permission_input_groups.each(function () {
            settings_components.initialize_disable_button_hint_popover(
                $(this),
                $t({defaultMessage: "You do not have permission to edit this setting."}),
            );
        });
        settings_components.disable_group_permission_setting($permission_input_groups);
    }
}

function show_membership_settings(group: UserGroup): void {
    const $edit_container = get_edit_container(group);

    const $member_container = $edit_container.find(".edit_members_for_user_group");
    user_group_edit_members.enable_member_management({
        group,
        $parent_container: $member_container,
    });

    update_members_panel_ui(group);
}

function show_general_settings(group: UserGroup): void {
    const permission_settings = group_permission_settings.get_group_permission_settings();
    for (const setting_name of permission_settings) {
        settings_components.create_group_setting_widget({
            $pill_container: $(`#id_${CSS.escape(setting_name)}`),
            setting_name,
            group,
        });
    }

    update_general_panel_ui(group);
}

function update_general_panel_ui(group: UserGroup): void {
    const $edit_container = get_edit_container(group);

    if (settings_data.can_manage_user_group(group.id)) {
        $edit_container.find(".group-header .button-group").show();
        $(
            `.group_settings_header[data-group-id='${CSS.escape(group.id.toString())}'] .deactivate`,
        ).show();
    } else {
        $edit_container.find(".group-header .button-group").hide();
        $(
            `.group_settings_header[data-group-id='${CSS.escape(group.id.toString())}'] .deactivate`,
        ).hide();
    }
    update_group_permission_settings_elements(group);
    update_group_membership_button(group.id);
}

function update_members_panel_ui(group: UserGroup): void {
    const $edit_container = get_edit_container(group);
    const $member_container = $edit_container.find(".edit_members_for_user_group");

    user_group_edit_members.rerender_members_list({
        group,
        $parent_container: $member_container,
    });
    update_add_members_elements(group);
}

export function update_group_management_ui(): void {
    if (!overlays.groups_open()) {
        return;
    }

    const active_group_id = get_active_data().id;

    if (active_group_id === undefined) {
        return;
    }

    const group = user_groups.get_user_group_from_id(active_group_id);

    update_general_panel_ui(group);
    update_members_panel_ui(group);
}

function group_membership_button(group_id: number): JQuery {
    return $(
        `.group_settings_header[data-group-id='${CSS.escape(group_id.toString())}'] .join_leave_button`,
    );
}

function initialize_tooltip_for_membership_button(group_id: number): void {
    const $tooltip_wrapper = group_membership_button(group_id).closest(
        ".join_leave_button_wrapper",
    );
    const is_member = user_groups.is_user_in_group(group_id, people.my_current_user_id());
    let tooltip_message;
    if (is_member) {
        tooltip_message = $t({defaultMessage: "You do not have permission to leave this group."});
    } else {
        tooltip_message = $t({defaultMessage: "You do not have permission to join this group."});
    }
    settings_components.initialize_disable_button_hint_popover($tooltip_wrapper, tooltip_message);
}

// Group membership button only adds or removes direct membership.
function update_group_membership_button(group_id: number): void {
    const $group_settings_button = group_membership_button(group_id);

    if ($group_settings_button.length === 0) {
        return;
    }

    const is_direct_member = user_groups.is_user_in_group(
        group_id,
        people.my_current_user_id(),
        true,
    );
    if (is_direct_member) {
        $group_settings_button.text($t({defaultMessage: "Leave group"}));
    } else {
        $group_settings_button.text($t({defaultMessage: "Join group"}));
    }

    const can_join_group = settings_data.can_join_user_group(group_id);
    const can_leave_group = settings_data.can_leave_user_group(group_id);

    let can_update_membership = true;
    if (!is_direct_member && !can_join_group) {
        can_update_membership = false;
    } else if (is_direct_member && !can_leave_group) {
        can_update_membership = false;
    }

    if (can_update_membership) {
        $group_settings_button.prop("disabled", false);
        $group_settings_button.css("pointer-events", "");
        const $group_settings_button_wrapper: JQuery<tippy.ReferenceElement> =
            $group_settings_button.closest(".join_leave_button_wrapper");
        $group_settings_button_wrapper[0]?._tippy?.destroy();
    } else {
        $group_settings_button.prop("disabled", true);
        initialize_tooltip_for_membership_button(group_id);
    }
}

function rerender_group_row(group: UserGroup): void {
    const $row = row_for_group_id(group.id);

    const item = group;

    const current_user_id = people.my_current_user_id();
    const is_member = user_groups.is_user_in_group(group.id, current_user_id);
    const can_join = settings_data.can_join_user_group(item.id);
    const can_leave = settings_data.can_leave_user_group(item.id);
    const is_direct_member = user_groups.is_direct_member_of(current_user_id, item.id);
    const associated_subgroups = user_groups.get_associated_subgroups(item, current_user_id);
    const associated_subgroup_names = user_groups.format_group_list(associated_subgroups);
    const item_render_data = {
        ...item,
        is_member,
        can_join,
        can_leave,
        is_direct_member,
        associated_subgroup_names,
    };
    const html = render_browse_user_groups_list_item(item_render_data);
    const $new_row = $(html);

    // TODO: Remove this if/when we just handle "active" when rendering templates.
    if ($row.hasClass("active")) {
        $new_row.addClass("active");
    }

    $row.replaceWith($new_row);
}

function update_display_checkmark_on_group_edit(group: UserGroup): void {
    const tab_key = get_active_data().$tabs.first().attr("data-tab-key");
    if (tab_key === "your-groups") {
        // There is no need to do anything if "Your groups" tab is
        // opened, because the whole list is already redrawn.
        return;
    }

    rerender_group_row(group);

    const current_user_id = people.my_current_user_id();
    const supergroups_of_group = user_groups.get_supergroups_of_user_group(group.id);
    for (const supergroup of supergroups_of_group) {
        if (user_groups.is_direct_member_of(current_user_id, supergroup.id)) {
            continue;
        }

        rerender_group_row(supergroup);
    }
}

function update_your_groups_list_if_needed(): void {
    // update display of group-rows on left panel.
    // We need this update only if your-groups tab is active
    // and current user is among the affect users as in that
    // case the group widget list need to be updated and show
    // or remove the group-row on the left panel accordingly.
    const tab_key = get_active_data().$tabs.first().attr("data-tab-key");
    if (tab_key === "your-groups") {
        // We add the group row to list if the current user
        // is added to it. The whole list is redrawed to
        // maintain the sorted order of groups.
        //
        // When the current user is removed from a group, the
        // whole list is redrawn because this action can also
        // affect the memberships of groups that have the
        // updated group as their subgroup.
        redraw_user_group_list();
    }
}

export function handle_subgroup_edit_event(group_id: number, direct_subgroup_ids: number[]): void {
    if (!overlays.groups_open()) {
        return;
    }
    const group = user_groups.get_user_group_from_id(group_id);

    const active_group_id = get_active_data().id;
    const current_user_id = people.my_current_user_id();

    const current_user_in_any_subgroup = user_groups.is_user_in_any_group(
        direct_subgroup_ids,
        current_user_id,
    );

    // update members list if currently rendered.
    if (group_id === active_group_id) {
        user_group_edit_members.update_member_list_widget(group);

        if (
            !user_groups.is_direct_member_of(current_user_id, group_id) &&
            current_user_in_any_subgroup
        ) {
            update_membership_status_text(group);
        }
    } else if (
        active_group_id !== undefined &&
        !user_groups.is_direct_member_of(current_user_id, active_group_id) &&
        user_groups.is_subgroup_of_target_group(active_group_id, group_id)
    ) {
        // Membership status text could still need an update
        // if updated group is one of the subgroup of the group
        // currently opened in right panel.
        const active_group = user_groups.get_user_group_from_id(active_group_id);
        update_membership_status_text(active_group);
    }

    if (current_user_in_any_subgroup) {
        update_your_groups_list_if_needed();
        update_display_checkmark_on_group_edit(group);
    }
}

function update_status_text_on_member_update(updated_group: UserGroup): void {
    const active_group_id = get_active_data().id;
    if (active_group_id === undefined) {
        return;
    }

    if (updated_group.id === active_group_id) {
        update_membership_status_text(updated_group);
        return;
    }

    // We might need to update the text if the updated groups is
    // one of the subgroups of the group opened in right panel.
    const current_user_id = people.my_current_user_id();
    if (user_groups.is_direct_member_of(current_user_id, active_group_id)) {
        // Since user is already a direct member of the group opened
        // in right panel, the text shown will remain the same.
        return;
    }

    const is_updated_group_subgroup = user_groups.is_subgroup_of_target_group(
        active_group_id,
        updated_group.id,
    );
    if (!is_updated_group_subgroup) {
        return;
    }

    const active_group = user_groups.get_user_group_from_id(active_group_id);
    update_membership_status_text(active_group);
}

function update_settings_for_group_overlay(group_id: number, user_ids: number[]): void {
    const group = user_groups.get_user_group_from_id(group_id);

    // update members list if currently rendered.
    if (is_editing_group(group_id)) {
        if (user_ids.includes(people.my_current_user_id())) {
            update_group_management_ui();
        } else {
            user_group_edit_members.update_member_list_widget(group);
        }
    }

    if (user_ids.includes(people.my_current_user_id())) {
        update_your_groups_list_if_needed();
        update_display_checkmark_on_group_edit(group);

        // Membership status text can be updated even when user was
        // added to a group which is not opened in the right panel as
        // membership can be impacted if the updated group is a
        // subgroup of the group opened in right panel.
        update_status_text_on_member_update(group);
    }
}

export function handle_member_edit_event(group_id: number, user_ids: number[]): void {
    if (overlays.groups_open()) {
        update_settings_for_group_overlay(group_id, user_ids);
    }
    user_profile.update_user_profile_groups_list_for_users(user_ids);
}

export function update_group_details(group: UserGroup): void {
    const $edit_container = get_edit_container(group);
    $edit_container.find(".group-name").text(group.name);
    $edit_container.find(".group-description").text(group.description);
}

function update_toggler_for_group_setting(): void {
    toggler.goto(select_tab);
}

function get_membership_status_context(group: UserGroup): {
    is_direct_member: boolean;
    is_member: boolean;
    associated_subgroup_names_html: string | undefined;
} {
    const current_user_id = people.my_current_user_id();
    const is_direct_member = user_groups.is_direct_member_of(current_user_id, group.id);

    let is_member;
    let associated_subgroup_names_html;
    if (is_direct_member) {
        is_member = true;
    } else {
        is_member = user_groups.is_user_in_group(group.id, current_user_id);
        if (is_member) {
            const associated_subgroup_names = user_groups
                .get_associated_subgroups(group, current_user_id)
                .map((subgroup) => subgroup.name);
            associated_subgroup_names_html = util.format_array_as_list_with_highlighted_elements(
                associated_subgroup_names,
                "long",
                "unit",
            );
        }
    }

    return {
        is_direct_member,
        is_member,
        associated_subgroup_names_html,
    };
}

function update_membership_status_text(group: UserGroup): void {
    const args = get_membership_status_context(group);
    const rendered_membership_status = render_user_group_membership_status(args);
    const $edit_container = get_edit_container(group);
    $edit_container.find(".membership-status").html(rendered_membership_status);
}

export function show_settings_for(group: UserGroup): void {
    const html = render_user_group_settings({
        group,
        date_created_string: timerender.get_localized_date_or_time_for_format(
            // We get timestamp in seconds from the API but timerender
            // needs milliseconds.
            //
            // Note that the 0 value will never be used in practice,
            // because group.date_created is undefined precisely when
            // group.creator_id is unset.
            new Date((group.date_created ?? 0) * 1000),
            "dayofyear_year",
        ),
        creator: stream_data.maybe_get_creator_details(group.creator_id),
        is_creator: group.creator_id === current_user.user_id,
        ...get_membership_status_context(group),
    });

    scroll_util.get_content_element($("#user_group_settings")).html(html);
    update_toggler_for_group_setting();

    toggler.get().prependTo("#user_group_settings .tab-container");
    const $edit_container = get_edit_container(group);
    $(".nothing-selected").hide();

    $edit_container.show();
    show_membership_settings(group);
    show_general_settings(group);
}

export function setup_group_settings(group: UserGroup): void {
    toggler = components.toggle({
        child_wants_focus: true,
        values: [
            {label: $t({defaultMessage: "General"}), key: "general"},
            {label: $t({defaultMessage: "Members"}), key: "members"},
        ],
        callback(_name, key) {
            $(".group_setting_section").hide();
            $(`[data-group-section="${CSS.escape(key)}"]`).show();
            select_tab = key;
            const hash = hash_util.group_edit_url(group, select_tab);
            browser_history.update(hash);
        },
    });

    show_settings_for(group);
}

export function setup_group_list_tab_hash(tab_key_value: string): void {
    /*
        We do not update the hash based on tab switches if
        a group is currently being edited.
    */
    if (get_active_data().id !== undefined) {
        return;
    }

    if (tab_key_value === "all-groups") {
        browser_history.update("#groups/all");
    } else if (tab_key_value === "your-groups") {
        browser_history.update("#groups/your");
    } else {
        blueslip.debug(`Unknown tab_key_value: ${tab_key_value} for groups overlay.`);
    }
}

function display_membership_toggle_spinner($group_row: JQuery): void {
    /* Prevent sending multiple requests by removing the button class. */
    $group_row.find(".check").removeClass("join_leave_button");

    /* Hide the tick. */
    const $tick = $group_row.find("svg");
    $tick.addClass("hide");

    /* Add a spinner to show the request is in process. */
    const $spinner = $group_row.find(".join_leave_status").expectOne();
    $spinner.show();
    loading.make_indicator($spinner);
}

function hide_membership_toggle_spinner($group_row: JQuery): void {
    /* Re-enable the button to handle requests. */
    $group_row.find(".check").addClass("join_leave_button");

    /* Show the tick. */
    const $tick = $group_row.find("svg");
    $tick.removeClass("hide");

    /* Destroy the spinner. */
    const $spinner = $group_row.find(".join_leave_status").expectOne();
    loading.destroy_indicator($spinner);
}

function empty_right_panel(): void {
    $(".group-row.active").removeClass("active");
    user_group_components.show_user_group_settings_pane.nothing_selected();
}

function open_right_panel_empty(): void {
    empty_right_panel();
    const tab_key = $(".user-groups-container")
        .find("div.ind-tab.selected")
        .first()
        .attr("data-tab-key");
    assert(tab_key !== undefined);
    setup_group_list_tab_hash(tab_key);
}

export function is_editing_group(desired_group_id: number): boolean {
    if (!overlays.groups_open()) {
        return false;
    }
    return get_active_data().id === desired_group_id;
}

export function handle_deleted_group(group_id: number): void {
    if (!overlays.groups_open()) {
        return;
    }

    if (is_editing_group(group_id)) {
        open_right_panel_empty();
    }
    redraw_user_group_list();
}

export function show_group_settings(group: UserGroup): void {
    $(".group-row.active").removeClass("active");
    user_group_components.show_user_group_settings_pane.settings(group);
    row_for_group_id(group.id).addClass("active");
    setup_group_settings(group);
}

export function open_group_edit_panel_for_row(group_row: HTMLElement): void {
    const group = get_user_group_for_target(group_row);
    if (group === undefined) {
        return;
    }
    show_group_settings(group);
}

// Ideally this should be included in page params.
// Like we have realm.max_stream_name_length` and
// `realm.max_stream_description_length` for streams.
export const max_user_group_name_length = 100;

export function set_up_click_handlers(): void {
    $("#groups_overlay").on("click", ".left #clear_search_group_name", (e) => {
        const $input = $("#groups_overlay .left #search_group_name");
        $input.val("");

        // This is a hack to rerender complete
        // stream list once the text is cleared.
        $input.trigger("input");

        e.stopPropagation();
        e.preventDefault();
    });
}

function create_user_group_clicked(): void {
    // this changes the tab switcher (settings/preview) which isn't necessary
    // to a add new stream title.
    user_group_components.show_user_group_settings_pane.create_user_group();
    $(".group-row.active").removeClass("active");

    user_group_create.show_new_user_group_modal();
    $("#create_user_group_name").trigger("focus");
}

export function do_open_create_user_group(): void {
    // Only call this directly for hash changes.
    // Prefer open_create_user_group().
    show_right_section();
    create_user_group_clicked();
}

export function open_create_user_group(): void {
    do_open_create_user_group();
    browser_history.update("#groups/new");
}

export function row_for_group_id(group_id: number): JQuery {
    return $(`.group-row[data-group-id='${CSS.escape(group_id.toString())}']`);
}

export function is_group_already_present(group: UserGroup): boolean {
    return row_for_group_id(group.id).length > 0;
}

export function get_active_data(): ActiveData {
    const $active_tabs = $(".user-groups-container").find("div.ind-tab.selected");
    const active_group_id = user_group_components.active_group_id;
    let $row;
    if (active_group_id !== undefined) {
        $row = row_for_group_id(active_group_id);
    }
    return {
        $row,
        id: user_group_components.active_group_id,
        $tabs: $active_tabs,
    };
}

export function switch_to_group_row(group: UserGroup): void {
    if (is_group_already_present(group)) {
        /*
            It is possible that this function may be called at times
            when group-row for concerned group may not be present this
            might occur when user manually edits the url for a group
            that user is not member of and #groups overlay is open with
            your-groups tab active.

            To handle such cases we perform these steps only if the group
            is listed in the left panel else we simply open the settings
            for the concerned group.
        */
        const $group_row = row_for_group_id(group.id);
        const $container = $(".user-groups-list");

        get_active_data().$row?.removeClass("active");
        $group_row.addClass("active");

        scroll_util.scroll_element_into_container($group_row, $container);
    }

    show_group_settings(group);
}

function show_right_section(): void {
    $(".right").addClass("show");
    $(".user-groups-header").addClass("slide-left");
}

export function add_group_to_table(group: UserGroup): void {
    if (is_group_already_present(group)) {
        // If a group is already listed/added in groups modal,
        // then we simply return.
        // This can happen in some corner cases (which might
        // be backend bugs) where a realm administrator may
        // get two user_group-add events.
        return;
    }

    redraw_user_group_list();

    if (user_group_create.get_name() === group.name) {
        // This `user_group_create.get_name()` check tells us whether the
        // group was just created in this browser window; it's a hack
        // to work around the server_events code flow not having a
        // good way to associate with this request because the group
        // ID isn't known yet.
        show_group_settings(group);
        user_group_create.reset_name();
    }
}

export function sync_group_permission_setting(property: string, group: UserGroup): void {
    const $elem = $(`#id_${CSS.escape(property)}`);
    const $subsection = $elem.closest(".settings-subsection-parent");
    if ($subsection.find(".save-button-controls").hasClass("hide")) {
        settings_org.discard_group_property_element_changes($elem, group);
    } else {
        settings_org.discard_group_settings_subsection_changes($subsection, group);
    }
}

export function update_group(event: UserGroupUpdateEvent): void {
    if (!overlays.groups_open()) {
        return;
    }

    const group_id = event.group_id;
    const group = user_groups.get_user_group_from_id(group_id);

    // update left side pane
    const $group_row = row_for_group_id(group_id);
    if (event.data.name !== undefined) {
        $group_row.find(".group-name").text(group.name);
    }

    if (event.data.description !== undefined) {
        $group_row.find(".description").text(group.description);
    }

    if (event.data.deactivated) {
        handle_deleted_group(group.id);
        return;
    }

    if (get_active_data().id === group.id) {
        // update right side pane
        update_group_details(group);
        if (event.data.name !== undefined) {
            // update settings title
            $("#groups_overlay .user-group-info-title").text(group.name);
        }
        if (event.data.can_mention_group !== undefined) {
            sync_group_permission_setting("can_mention_group", group);
            update_group_management_ui();
        }
        if (event.data.can_add_members_group !== undefined) {
            sync_group_permission_setting("can_add_members_group", group);
            update_group_management_ui();
        }
        if (event.data.can_manage_group !== undefined) {
            sync_group_permission_setting("can_manage_group", group);
            update_group_management_ui();
        }
        if (event.data.can_join_group !== undefined) {
            sync_group_permission_setting("can_join_group", group);
            update_group_membership_button(group.id);
        }
        if (event.data.can_leave_group !== undefined) {
            sync_group_permission_setting("can_leave_group", group);
            update_group_membership_button(group.id);
        }
        if (event.data.can_remove_members_group !== undefined) {
            sync_group_permission_setting("can_remove_members_group", group);
            update_group_management_ui();
        }
    }
}

export function change_state(
    section: string,
    left_side_tab: string | undefined,
    right_side_tab: string,
): void {
    if (section === "new") {
        do_open_create_user_group();
        redraw_user_group_list();
        return;
    }

    if (section === "all") {
        group_list_toggler.goto("all-groups");
        empty_right_panel();
        return;
    }

    // if the section is a valid number.
    if (/\d+/.test(section)) {
        const group_id = Number.parseInt(section, 10);
        const group = user_groups.get_user_group_from_id(group_id);
        show_right_section();
        select_tab = right_side_tab;

        if (left_side_tab === undefined) {
            left_side_tab = "all-groups";
            if (user_groups.is_user_in_group(group_id, current_user.user_id)) {
                left_side_tab = "your-groups";
            }
        }

        // Callback to .goto() will update browser_history unless a
        // group is being edited. We are always editing a group here
        // so its safe to call
        if (left_side_tab !== group_list_toggler.value()) {
            user_group_components.set_active_group_id(group.id);
            group_list_toggler.goto(left_side_tab);
        }
        switch_to_group_row(group);
        return;
    }

    group_list_toggler.goto("your-groups");
    empty_right_panel();
}

function compare_by_name(a: UserGroup, b: UserGroup): number {
    return util.strcmp(a.name, b.name);
}

function redraw_left_panel(tab_name: string): void {
    let groups_list_data;
    if (tab_name === "all-groups") {
        groups_list_data = user_groups.get_realm_user_groups();
    } else if (tab_name === "your-groups") {
        groups_list_data = user_groups.get_user_groups_of_user(people.my_current_user_id());
    }
    if (groups_list_data === undefined) {
        return;
    }
    groups_list_data.sort(compare_by_name);
    group_list_widget.replace_list_data(groups_list_data);
    update_empty_left_panel_message();
    maybe_reset_right_panel(groups_list_data);
}

export function redraw_user_group_list(): void {
    const tab_name = get_active_data().$tabs.first().attr("data-tab-key");
    assert(tab_name !== undefined);
    redraw_left_panel(tab_name);
}

export function switch_group_tab(tab_name: string): void {
    /*
        This switches the groups list tab, but it doesn't update
        the group_list_toggler widget.  You may instead want to
        use `group_list_toggler.goto`.
    */
    redraw_left_panel(tab_name);
    setup_group_list_tab_hash(tab_name);
}

export function add_or_remove_from_group(group: UserGroup, $group_row: JQuery): void {
    const user_id = people.my_current_user_id();
    function success_callback(): void {
        if ($group_row.length > 0) {
            hide_membership_toggle_spinner($group_row);
            // This should only be triggered when a user is on another group
            // edit panel and they join a group via the left panel plus button.
            // In that case, the edit panel of the newly joined group should
            // open. `is_user_in_group` with direct_members_only set to true acts
            // as a proxy to check if it's an `add_members` event.
            if (
                !is_editing_group(group.id) &&
                user_groups.is_user_in_group(group.id, user_id, true)
            ) {
                open_group_edit_panel_for_row(util.the($group_row));
            }
        }
    }

    function error_callback(): void {
        if ($group_row.length > 0) {
            hide_membership_toggle_spinner($group_row);
        }
    }

    if ($group_row.length > 0) {
        display_membership_toggle_spinner($group_row);
    }
    if (user_groups.is_direct_member_of(user_id, group.id)) {
        user_group_edit_members.edit_user_group_membership({
            group,
            removed: [user_id],
            success: success_callback,
            error: error_callback,
        });
    } else {
        user_group_edit_members.edit_user_group_membership({
            group,
            added: [user_id],
            success: success_callback,
            error: error_callback,
        });
    }
}

export function maybe_reset_right_panel(groups_list_data: UserGroup[]): void {
    if (user_group_components.active_group_id === undefined) {
        return;
    }

    const group_ids = new Set(groups_list_data.map((group) => group.id));
    if (!group_ids.has(user_group_components.active_group_id)) {
        user_group_components.show_user_group_settings_pane.nothing_selected();
    }
}

export function update_empty_left_panel_message(): void {
    // Check if we have any groups in panel to decide whether to
    // display a notice.
    let has_groups;
    const is_your_groups_tab_active =
        get_active_data().$tabs.first().attr("data-tab-key") === "your-groups";
    if (is_your_groups_tab_active) {
        has_groups = user_groups.get_user_groups_of_user(people.my_current_user_id()).length;
    } else {
        has_groups = user_groups.get_realm_user_groups().length;
    }
    if (has_groups) {
        $(".no-groups-to-show").hide();
        return;
    }
    if (is_your_groups_tab_active) {
        $(".all_groups_tab_empty_text").hide();
        $(".your_groups_tab_empty_text").show();
    } else {
        $(".your_groups_tab_empty_text").hide();
        $(".all_groups_tab_empty_text").show();
    }
    $(".no-groups-to-show").show();
}

export function remove_deactivated_user_from_all_groups(user_id: number): void {
    const all_user_groups = user_groups.get_realm_user_groups(true);

    for (const user_group of all_user_groups) {
        if (user_groups.is_direct_member_of(user_id, user_group.id)) {
            user_groups.remove_members(user_group.id, [user_id]);
        }

        // update members list if currently rendered.
        if (overlays.groups_open() && is_editing_group(user_group.id)) {
            user_group_edit_members.update_member_list_widget(user_group);
        }
    }
}

export function setup_page(callback: () => void): void {
    function initialize_components(): void {
        group_list_toggler = components.toggle({
            child_wants_focus: true,
            values: [
                {label: $t({defaultMessage: "Your groups"}), key: "your-groups"},
                {label: $t({defaultMessage: "All groups"}), key: "all-groups"},
            ],
            callback(_label, key) {
                switch_group_tab(key);
            },
        });

        group_list_toggler.get().prependTo("#groups_overlay_container .list-toggler-container");
    }

    function populate_and_fill(): void {
        const template_data = {
            can_create_user_groups: settings_data.user_can_create_user_groups(),
            zulip_plan_is_not_limited: realm.zulip_plan_is_not_limited,
            upgrade_text_for_wide_organization_logo: realm.upgrade_text_for_wide_organization_logo,
            is_business_type_org:
                realm.realm_org_type === settings_config.all_org_type_values.business.code,
            max_user_group_name_length,
        };

        const groups_overlay_html = render_user_group_settings_overlay(template_data);

        const $groups_overlay_container = scroll_util.get_content_element(
            $("#groups_overlay_container"),
        );
        $groups_overlay_container.html(groups_overlay_html);

        const context = {
            banner_type: compose_banner.INFO,
            classname: "group_info",
            hide_close_button: true,
            button_text: $t({defaultMessage: "Learn more"}),
            button_link: "/help/user-groups",
        };

        $("#groups_overlay_container .nothing-selected .group-info-banner").html(
            render_group_info_banner(context),
        );

        // Initially as the overlay is build with empty right panel,
        // active_group_id is undefined.
        user_group_components.reset_active_group_id();

        const $container = $("#groups_overlay_container .user-groups-list");

        /*
            As change_state function called after this initial build up
            redraws left panel based on active tab we avoid building extra dom
            here as the required group-rows are anyway going to be created
            immediately after this due to call to change_state. So we call
            `ListWidget.create` with empty user groups list.
        */
        const empty_user_group_list: UserGroup[] = [];
        group_list_widget = ListWidget.create($container, empty_user_group_list, {
            name: "user-groups-overlay",
            get_item: ListWidget.default_get_item,
            modifier_html(item) {
                const is_member = user_groups.is_user_in_group(
                    item.id,
                    people.my_current_user_id(),
                );
                const is_direct_member = user_groups.is_direct_member_of(
                    people.my_current_user_id(),
                    item.id,
                );
                const associated_subgroups = user_groups.get_associated_subgroups(
                    item,
                    people.my_current_user_id(),
                );
                const associated_subgroup_names =
                    user_groups.format_group_list(associated_subgroups);
                const can_join = settings_data.can_join_user_group(item.id);
                const can_leave = settings_data.can_leave_user_group(item.id);
                const item_render_data = {
                    ...item,
                    is_member,
                    is_direct_member,
                    associated_subgroup_names,
                    can_join,
                    can_leave,
                };
                return render_browse_user_groups_list_item(item_render_data);
            },
            filter: {
                $element: $("#groups_overlay_container .left #search_group_name"),
                predicate(item, value) {
                    return (
                        item &&
                        (item.name.toLocaleLowerCase().includes(value) ||
                            item.description.toLocaleLowerCase().includes(value))
                    );
                },
                onupdate() {
                    if (user_group_components.active_group_id !== undefined) {
                        const active_group = user_groups.get_user_group_from_id(
                            user_group_components.active_group_id,
                        );
                        if (is_group_already_present(active_group)) {
                            row_for_group_id(user_group_components.active_group_id).addClass(
                                "active",
                            );
                        }
                    }
                },
            },
            init_sort: ["alphabetic", "name"],
            $simplebar_container: $container,
        });

        initialize_components();

        set_up_click_handlers();
        user_group_create.set_up_handlers();

        // show the "User group settings" header by default.
        $(".display-type #user_group_settings_title").show();

        if (callback) {
            callback();
        }
    }

    populate_and_fill();
}

type DeactivationBannerArgs = {
    streams_using_group_for_setting: {
        stream_name: string;
        setting_url: string | undefined;
    }[];
    groups_using_group_for_setting: {
        group_name: string;
        setting_url: string;
    }[];
    realm_using_group_for_setting: boolean;
};

function parse_args_for_deactivation_banner(
    objections: Record<string, unknown>[],
): DeactivationBannerArgs {
    const args: DeactivationBannerArgs = {
        streams_using_group_for_setting: [],
        groups_using_group_for_setting: [],
        realm_using_group_for_setting: false,
    };
    for (const objection of objections) {
        if (objection.type === "channel") {
            const stream_id = objection.channel_id;
            assert(typeof stream_id === "number");
            const sub = stream_data.get_sub_by_id(stream_id);
            if (sub !== undefined) {
                args.streams_using_group_for_setting.push({
                    stream_name: sub.name,
                    setting_url: hash_util.channels_settings_edit_url(sub, "general"),
                });
            } else {
                args.streams_using_group_for_setting.push({
                    stream_name: $t({defaultMessage: "Unknown channel"}),
                    setting_url: undefined,
                });
            }
            continue;
        }

        if (objection.type === "user_group") {
            const group_id = objection.group_id;
            assert(typeof group_id === "number");
            const group = user_groups.get_user_group_from_id(group_id);
            const setting_url = hash_util.group_edit_url(group, "general");
            args.groups_using_group_for_setting.push({group_name: group.name, setting_url});
            continue;
        }

        if (objection.type === "realm") {
            args.realm_using_group_for_setting = true;
        }
    }
    return args;
}

export function initialize(): void {
    $("#groups_overlay_container").on("click", ".group-row", function (this: HTMLElement) {
        if ($(this).closest(".check, .user_group_settings_wrapper").length === 0) {
            open_group_edit_panel_for_row(this);
        }
    });

    $("#groups_overlay_container").on(
        "click",
        "#open_group_info_modal",
        function (this: HTMLElement, e) {
            e.preventDefault();
            e.stopPropagation();
            const user_group_id = get_user_group_id(this);
            const user_group = user_groups.get_user_group_from_id(user_group_id);
            const template_data = {
                group_name: user_group.name,
                group_description: user_group.description,
                max_user_group_name_length,
            };
            const change_user_group_info_modal = render_change_user_group_info_modal(template_data);
            dialog_widget.launch({
                html_heading: $t_html(
                    {defaultMessage: "Edit {group_name}"},
                    {group_name: user_group.name},
                ),
                html_body: change_user_group_info_modal,
                id: "change_group_info_modal",
                loading_spinner: true,
                on_click: save_group_info,
                post_render() {
                    $("#change_group_info_modal .dialog_submit_button")
                        .addClass("save-button")
                        .attr("data-group-id", user_group_id);
                },
                update_submit_disabled_state_on_change: true,
            });
        },
    );

    $("#groups_overlay_container").on("click", ".group_settings_header .button-danger", () => {
        const active_group_data = get_active_data();
        const group_id = active_group_data.id;
        assert(group_id !== undefined);
        const user_group = user_groups.get_user_group_from_id(group_id);

        if (!user_group || !settings_data.can_manage_user_group(group_id)) {
            return;
        }
        function deactivate_user_group(): void {
            channel.post({
                url: "/json/user_groups/" + group_id + "/deactivate",
                data: {},
                success() {
                    dialog_widget.close();
                    active_group_data.$row?.remove();
                },
                error(xhr) {
                    dialog_widget.hide_dialog_spinner();
                    const parsed = z
                        .object({
                            code: z.string(),
                            msg: z.string(),
                            objections: z.array(z.record(z.string(), z.unknown())),
                            result: z.string(),
                        })
                        .safeParse(xhr.responseJSON);
                    if (parsed.success && parsed.data.code === "CANNOT_DEACTIVATE_GROUP_IN_USE") {
                        $("#deactivation-confirm-modal .dialog_submit_button").prop(
                            "disabled",
                            true,
                        );
                        const objections = parsed.data.objections;
                        const template_args = parse_args_for_deactivation_banner(objections);
                        const rendered_error_banner =
                            render_cannot_deactivate_group_banner(template_args);
                        $("#dialog_error")
                            .html(rendered_error_banner)
                            .addClass("alert-error")
                            .show();
                    } else {
                        ui_report.error($t({defaultMessage: "Failed"}), xhr, $("#dialog_error"));
                    }
                },
            });
        }

        const html_body = render_confirm_delete_user({
            group_name: user_group.name,
        });

        const user_group_name = user_group.name;

        confirm_dialog.launch({
            html_heading: $t_html(
                {defaultMessage: "Deactivate {user_group_name}?"},
                {user_group_name},
            ),
            html_body,
            on_click: deactivate_user_group,
            close_on_submit: false,
            loading_spinner: true,
            id: "deactivation-confirm-modal",
        });
    });

    function save_group_info(e: JQuery.ClickEvent): void {
        assert(e.currentTarget instanceof HTMLElement);
        const group = get_user_group_for_target(e.currentTarget);
        assert(group !== undefined);
        const url = `/json/user_groups/${group.id}`;
        let name;
        let description;
        const new_name = $<HTMLInputElement>("#change_user_group_name").val()!.trim();
        const new_description = $<HTMLInputElement>("#change_user_group_description").val()!.trim();

        if (new_name !== group.name) {
            name = new_name;
        }
        if (new_description !== group.description) {
            description = new_description;
        }
        const data = {
            name,
            description,
        };
        dialog_widget.submit_api_request(channel.patch, url, data);
    }

    $("#groups_overlay_container").on("click", ".create_user_group_button", (e) => {
        e.preventDefault();
        open_create_user_group();
    });

    $("#groups_overlay_container").on("click", "#user_group_creation_form [data-dismiss]", (e) => {
        e.preventDefault();
        // we want to make sure that the click is not just a simulated
        // click; this fixes an issue where hitting "Enter" would
        // trigger this code path due to bootstrap magic.
        if (e.clientY !== 0) {
            open_right_panel_empty();
        }
    });

    $("#groups_overlay_container").on("click", ".group-row", show_right_section);

    $("#groups_overlay_container").on("click", ".fa-chevron-left", () => {
        $(".right").removeClass("show");
        $(".user-groups-header").removeClass("slide-left");
    });

    $("#groups_overlay_container").on("click", ".join_leave_button", function (this: HTMLElement) {
        if ($(this).hasClass("disabled") || $(this).hasClass("not-direct-member")) {
            // We return early if user is not allowed to join or leave a group.
            return;
        }

        const user_group_id = get_user_group_id(this);
        const user_group = user_groups.get_user_group_from_id(user_group_id);
        const is_member = user_groups.is_user_in_group(user_group_id, people.my_current_user_id());
        const is_direct_member = user_groups.is_direct_member_of(
            people.my_current_user_id(),
            user_group_id,
        );

        if (is_member && !is_direct_member) {
            const associated_subgroups = user_groups.get_associated_subgroups(
                user_group,
                people.my_current_user_id(),
            );
            const associated_subgroup_names = user_groups.format_group_list(associated_subgroups);

            confirm_dialog.launch({
                html_heading: $t_html({defaultMessage: "Join group?"}),
                html_body: render_confirm_join_group_direct_member({
                    associated_subgroup_names,
                }),
                id: "confirm_join_group_direct_member",
                on_click() {
                    const $group_row = row_for_group_id(user_group_id);
                    add_or_remove_from_group(user_group, $group_row);
                },
            });
        } else {
            const $group_row = row_for_group_id(user_group_id);
            add_or_remove_from_group(user_group, $group_row);
        }
    });

    $("#groups_overlay_container").on(
        "click",
        ".subsection-header .subsection-changes-save button",
        function (this: HTMLElement, e) {
            e.preventDefault();
            e.stopPropagation();
            const $save_button = $(this);
            const $subsection_elem = $save_button.closest(".settings-subsection-parent");

            const group_id: unknown = $save_button
                .closest(".user_group_settings_wrapper")
                .data("group-id");
            assert(typeof group_id === "number");
            const group = user_groups.get_user_group_from_id(group_id);
            const data = settings_components.populate_data_for_group_request(
                $subsection_elem,
                group,
            );

            const url = "/json/user_groups/" + group_id;
            settings_org.save_organization_settings(data, $save_button, url);
        },
    );

    $("#groups_overlay_container").on(
        "click",
        ".subsection-header .subsection-changes-discard button",
        function (this: HTMLElement, e) {
            e.preventDefault();
            e.stopPropagation();

            const group_id: unknown = $(this)
                .closest(".user_group_settings_wrapper")
                .data("group-id");
            assert(typeof group_id === "number");
            const group = user_groups.get_user_group_from_id(group_id);

            const $subsection = $(this).closest(".settings-subsection-parent");
            settings_org.discard_group_settings_subsection_changes($subsection, group);
        },
    );
}

export function launch(
    section: string,
    left_side_tab: string | undefined,
    right_side_tab: string,
): void {
    setup_page(() => {
        overlays.open_overlay({
            name: "group_subscriptions",
            $overlay: $("#groups_overlay"),
            on_close() {
                browser_history.exit_overlay();
            },
        });
        change_state(section, left_side_tab, right_side_tab);
    });
    if (!get_active_data().id) {
        if (section === "new") {
            $("#create_user_group_name").trigger("focus");
        } else {
            $("#search_group_name").trigger("focus");
        }
    }
}
