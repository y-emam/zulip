import type {Meta, UppyFile} from "@uppy/core";
import {Uppy} from "@uppy/core";
import Tus from "@uppy/tus";
import $ from "jquery";
import assert from "minimalistic-assert";
import {z} from "zod";

import render_upload_banner from "../templates/compose_banner/upload_banner.hbs";

import * as blueslip from "./blueslip.ts";
import * as compose_actions from "./compose_actions.ts";
import * as compose_banner from "./compose_banner.ts";
import * as compose_reply from "./compose_reply.ts";
import * as compose_state from "./compose_state.ts";
import * as compose_ui from "./compose_ui.ts";
import * as compose_validate from "./compose_validate.ts";
import {$t} from "./i18n.ts";
import * as message_lists from "./message_lists.ts";
import * as rows from "./rows.ts";
import {realm} from "./state_data.ts";

let drag_drop_img: HTMLElement | null = null;
let compose_upload_object: Uppy;
const upload_objects_by_message_edit_row = new Map<number, Uppy>();

export function compose_upload_cancel(): void {
    compose_upload_object.cancelAll();
}

export function feature_check(): XMLHttpRequestUpload {
    // Show the upload button only if the browser supports it.
    return window.XMLHttpRequest && new window.XMLHttpRequest().upload;
}

export function get_translated_status(file: File | UppyFile<Meta, Record<string, never>>): string {
    const status = $t({defaultMessage: "Uploading {filename}…"}, {filename: file.name});
    return "[" + status + "]()";
}

type Config = ({mode: "compose"} | {mode: "edit"; row: number}) & {
    textarea: () => JQuery<HTMLTextAreaElement>;
    send_button: () => JQuery;
    banner_container: () => JQuery;
    upload_banner_identifier: (file_id: string) => string;
    upload_banner: (file_id: string) => JQuery;
    upload_banner_cancel_button: (file_id: string) => JQuery;
    upload_banner_hide_button: (file_id: string) => JQuery;
    upload_banner_message: (file_id: string) => JQuery;
    file_input_identifier: () => string;
    source: () => string;
    drag_drop_container: () => JQuery;
    markdown_preview_hide_button: () => JQuery;
};

export const compose_config: Config = {
    mode: "compose",
    textarea: () => $<HTMLTextAreaElement>("textarea#compose-textarea"),
    send_button: () => $("#compose-send-button"),
    banner_container: () => $("#compose_banners"),
    upload_banner_identifier: (file_id) =>
        `#compose_banners .upload_banner.file_${CSS.escape(file_id)}`,
    upload_banner: (file_id) => $(`#compose_banners .upload_banner.file_${CSS.escape(file_id)}`),
    upload_banner_cancel_button: (file_id) =>
        $(
            `#compose_banners .upload_banner.file_${CSS.escape(
                file_id,
            )} .upload_banner_cancel_button`,
        ),
    upload_banner_hide_button: (file_id) =>
        $(
            `#compose_banners .upload_banner.file_${CSS.escape(
                file_id,
            )} .main-view-banner-close-button`,
        ),
    upload_banner_message: (file_id) =>
        $(`#compose_banners .upload_banner.file_${CSS.escape(file_id)} .upload_msg`),
    file_input_identifier: () => "#compose input.file_input",
    source: () => "compose-file-input",
    drag_drop_container: () => $("#compose"),
    markdown_preview_hide_button: () => $("#compose .undo_markdown_preview"),
};

export function edit_config(row: number): Config {
    return {
        mode: "edit",
        row,
        textarea: () =>
            $<HTMLTextAreaElement>(
                `#edit_form_${CSS.escape(`${row}`)} textarea.message_edit_content`,
            ),
        send_button: () => $(`#edit_form_${CSS.escape(`${row}`)}`).find(".message_edit_save"),
        banner_container: () => $(`#edit_form_${CSS.escape(`${row}`)} .edit_form_banners`),
        upload_banner_identifier: (file_id) =>
            `#edit_form_${CSS.escape(`${row}`)} .upload_banner.file_${CSS.escape(file_id)}`,
        upload_banner: (file_id) =>
            $(`#edit_form_${CSS.escape(`${row}`)} .upload_banner.file_${CSS.escape(file_id)}`),
        upload_banner_cancel_button: (file_id) =>
            $(
                `#edit_form_${CSS.escape(`${row}`)} .upload_banner.file_${CSS.escape(
                    file_id,
                )} .upload_banner_cancel_button`,
            ),
        upload_banner_hide_button: (file_id) =>
            $(
                `#edit_form_${CSS.escape(`${row}`)} .upload_banner.file_${CSS.escape(
                    file_id,
                )} .main-view-banner-close-button`,
            ),
        upload_banner_message: (file_id) =>
            $(
                `#edit_form_${CSS.escape(`${row}`)} .upload_banner.file_${CSS.escape(
                    file_id,
                )} .upload_msg`,
            ),
        file_input_identifier: () => `#edit_form_${CSS.escape(`${row}`)} input.file_input`,
        source: () => "message-edit-file-input",
        drag_drop_container() {
            assert(message_lists.current !== undefined);
            return $(
                `#message-row-${message_lists.current.id}-${CSS.escape(`${row}`)} .message_edit_form`,
            );
        },
        markdown_preview_hide_button: () =>
            $(`#edit_form_${CSS.escape(`${row}`)} .undo_markdown_preview`),
    };
}

export let hide_upload_banner = (uppy: Uppy, config: Config, file_id: string): void => {
    config.upload_banner(file_id).remove();
    if (uppy.getFiles().length === 0) {
        if (config.mode === "compose") {
            compose_validate.set_upload_in_progress(false);
        } else {
            config.send_button().prop("disabled", false);
        }
    }
};

export function rewire_hide_upload_banner(value: typeof hide_upload_banner): void {
    hide_upload_banner = value;
}

function add_upload_banner(
    config: Config,
    banner_type: string,
    banner_text: string,
    file_id: string,
    is_upload_process_tracker = false,
): void {
    const new_banner_html = render_upload_banner({
        banner_type,
        is_upload_process_tracker,
        banner_text,
        file_id,
    });
    compose_banner.append_compose_banner_to_banner_list(
        $(new_banner_html),
        config.banner_container(),
    );
}

export function show_error_message(
    config: Config,
    message = $t({defaultMessage: "An unknown error occurred."}),
    file_id: string | null = null,
): void {
    if (file_id) {
        $(`${config.upload_banner_identifier(file_id)} .moving_bar`).hide();
        config.upload_banner(file_id).removeClass("info").addClass("error");
        config.upload_banner_message(file_id).text(message);
    } else {
        // We still use a "file_id" (that's not actually related to a file)
        // to differentiate this banner from banners that *are* associated
        // with files. This is notably relevant for the close click handler.
        add_upload_banner(config, "error", message, "generic_error");
    }
}

export let upload_files = (uppy: Uppy, config: Config, files: File[] | FileList): void => {
    if (files.length === 0) {
        return;
    }
    if (realm.max_file_upload_size_mib === 0) {
        show_error_message(
            config,
            $t({
                defaultMessage: "File and image uploads have been disabled for this organization.",
            }),
        );
        return;
    }

    // If we're looking at a markdown preview, switch back to the edit
    // UI.  This is important for all the later logic around focus
    // (etc.) to work correctly.
    //
    // We implement this transition through triggering a click on the
    // toggle button to take advantage of the existing plumbing for
    // handling the compose and edit UIs.
    if (config.markdown_preview_hide_button().is(":visible")) {
        config.markdown_preview_hide_button().trigger("click");
    }

    for (const file of files) {
        let file_id;
        try {
            compose_ui.insert_syntax_and_focus(
                get_translated_status(file),
                config.textarea(),
                "block",
                1,
            );
            compose_ui.autosize_textarea(config.textarea());
            file_id = uppy.addFile({
                source: config.source(),
                name: file.name,
                type: file.type,
                data: file,
            });
        } catch {
            // Errors are handled by info-visible and upload-error event callbacks.
            continue;
        }

        if (config.mode === "compose") {
            compose_validate.set_upload_in_progress(true);
        } else {
            config.send_button().prop("disabled", true);
        }
        add_upload_banner(
            config,
            "info",
            $t({defaultMessage: "Uploading {filename}…"}, {filename: file.name}),
            file_id,
            true,
        );
        // eslint-disable-next-line no-loop-func
        config.upload_banner_cancel_button(file_id).one("click", () => {
            compose_ui.replace_syntax(get_translated_status(file), "", config.textarea());
            compose_ui.autosize_textarea(config.textarea());
            config.textarea().trigger("focus");

            uppy.removeFile(file_id);
            hide_upload_banner(uppy, config, file_id);
        });
        // eslint-disable-next-line no-loop-func
        config.upload_banner_hide_button(file_id).one("click", () => {
            hide_upload_banner(uppy, config, file_id);
        });
    }
};

export function rewire_upload_files(value: typeof upload_files): void {
    upload_files = value;
}

export function setup_upload(config: Config): Uppy {
    const uppy = new Uppy({
        debug: false,
        autoProceed: true,
        restrictions: {
            maxFileSize: realm.max_file_upload_size_mib * 1024 * 1024,
        },
        locale: {
            strings: {
                exceedsSize: $t(
                    {
                        defaultMessage:
                            "%'{file}' exceeds the maximum file size for attachments ({variable} MB).",
                    },
                    {variable: `${realm.max_file_upload_size_mib}`},
                ),
                failedToUpload: $t({defaultMessage: "Failed to upload %'{file}'"}),
            },
            pluralize: (_n) => 0,
        },
    });
    uppy.use(Tus, {
        // https://uppy.io/docs/tus/#options
        endpoint: "/api/v1/tus/",
        // The tus-js-client fingerprinting feature stores metadata on
        // previously uploaded files in browser local storage, to
        // allow resuming the upload / avoiding a repeat upload in
        // future browser sessions.
        //
        // This is not a feature we need across browser sessions. Since these local storage
        // entries are never garbage-collected, can be accessed via
        // the browser console even after logging out, and contain
        // some metadata about previously uploaded files, which seems
        // like a security risk for using Zulip on a public computer. So we
        // disable the feature.
        //
        // TODO: The better fix would be to define a `urlStorage` that is
        // backed by a simple JavaScript map, so that the resume/repeat
        // features are available, but with a duration of the current session.
        storeFingerprintForResuming: false,
        // Number of concurrent uploads
        limit: 5,
    });

    if (config.mode === "edit") {
        upload_objects_by_message_edit_row.set(config.row, uppy);
    }

    uppy.on("upload-progress", (file, progress) => {
        assert(file !== undefined);
        assert(progress.bytesTotal !== null);
        const percent_complete = (100 * progress.bytesUploaded) / progress.bytesTotal;
        $(`${config.upload_banner_identifier(file.id)} .moving_bar`).css({
            width: `${percent_complete}%`,
        });
    });

    $<HTMLInputElement>(config.file_input_identifier()).on("change", (event) => {
        const files = event.target.files;
        assert(files !== null);
        upload_files(uppy, config, files);
        config.textarea().trigger("focus");
        event.target.value = "";
    });

    const $banner_container = config.banner_container();
    $banner_container.on(
        "click",
        ".upload_banner.file_generic_error .main-view-banner-close-button",
        (event) => {
            event.preventDefault();
            $(event.target).parents(".upload_banner").remove();
        },
    );

    const $drag_drop_container = config.drag_drop_container();
    $drag_drop_container.on("dragover", (event) => {
        event.preventDefault();
    });
    $drag_drop_container.on("dragenter", (event) => {
        event.preventDefault();
    });

    $drag_drop_container.on("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        assert(event.originalEvent !== undefined);
        assert(event.originalEvent.dataTransfer !== null);
        const files = event.originalEvent.dataTransfer.files;
        if (config.mode === "compose" && !compose_state.composing()) {
            compose_reply.respond_to_message({
                trigger: "file drop or paste",
                keep_composebox_empty: true,
            });
        }
        upload_files(uppy, config, files);
    });

    $drag_drop_container.on("paste", (event) => {
        assert(event.originalEvent instanceof ClipboardEvent);
        const clipboard_data = event.originalEvent.clipboardData;
        if (!clipboard_data) {
            return;
        }
        const items = clipboard_data.items;
        const files = [];
        for (const item of items) {
            const file = item.getAsFile();
            if (file === null) {
                continue;
            }
            files.push(file);
        }
        if (files.length === 0) {
            // Exit when there are no files from the clipboard
            return;
        }
        // Halt the normal browser paste event, which would otherwise
        // present a plain-text version of the file name.
        event.preventDefault();
        if (config.mode === "compose" && !compose_state.composing()) {
            compose_reply.respond_to_message({
                trigger: "file drop or paste",
                keep_composebox_empty: true,
            });
        }
        upload_files(uppy, config, files);
    });

    uppy.on("upload-success", (file, _response) => {
        assert(file !== undefined);
        // TODO: Because of https://github.com/transloadit/uppy/issues/5444 we can't get the actual
        // response with the URL and filename, so we hack it together.
        const filename = file.name!;
        // With the S3 backend, the path_id we chose has a multipart-id appended with a '+'; since
        // our path-ids cannot contain '+', we strip any suffix starting with '+'.
        const url = new URL(file.tus!.uploadUrl!.replace(/\+.*/, "")).pathname.replace(
            "/api/v1/tus/",
            "/user_uploads/",
        );

        const filtered_filename = filename.replaceAll("[", "").replaceAll("]", "");
        const syntax_to_insert = "[" + filtered_filename + "](" + url + ")";
        const $text_area = config.textarea();
        const replacement_successful = compose_ui.replace_syntax(
            get_translated_status(file),
            syntax_to_insert,
            $text_area,
        );
        if (!replacement_successful) {
            compose_ui.insert_syntax_and_focus(syntax_to_insert, $text_area);
        }

        compose_ui.autosize_textarea($text_area);

        // The uploaded files should be removed since uppy doesn't allow files in the store
        // to be re-uploaded again.
        uppy.removeFile(file.id);
        // Hide upload status after waiting 100ms after the 1s transition to 100%
        // so that the user can see the progress bar at 100%.
        setTimeout(() => {
            hide_upload_banner(uppy, config, file.id);
        }, 1100);
    });

    uppy.on("info-visible", () => {
        // Uppy's `info-visible` event is issued after appending the
        // notice details into the list of event events accessed via
        // uppy.getState().info. Extract the notice details so that we
        // can potentially act on the error.
        //
        // TODO: Ideally, we'd be using the `.error()` hook or
        // something, not parsing error message strings.
        const infoList = uppy.getState().info;
        assert(infoList !== undefined);
        const info = infoList.at(-1);
        assert(info !== undefined);
        if (info.type === "error" && info.message === "No Internet connection") {
            // server_events already handles the case of no internet.
            return;
        }

        if (info.type === "error" && info.details === "Upload Error") {
            // The server errors come under 'Upload Error'. But we can't handle them
            // here because info object don't contain response.body.msg received from
            // the server. Server errors are hence handled by on('upload-error').
            return;
        }

        if (info.type === "error") {
            // The remaining errors are mostly frontend errors like file being too large
            // for upload.
            show_error_message(config, info.message);
        }
    });

    uppy.on("upload-error", (file, _error, response) => {
        assert(file !== undefined);
        // The files with failed upload should be removed since uppy doesn't allow files in the store
        // to be re-uploaded again.
        uppy.removeFile(file.id);

        let parsed;
        const message =
            response !== undefined &&
            (parsed = z.object({msg: z.string()}).safeParse(response.body)).success
                ? parsed.data.msg
                : undefined;
        // Hide the upload status banner on error so only the error banner shows
        hide_upload_banner(uppy, config, file.id);
        show_error_message(config, message, file.id);
        compose_ui.replace_syntax(get_translated_status(file), "", config.textarea());
        compose_ui.autosize_textarea(config.textarea());
    });

    uppy.on("restriction-failed", (file) => {
        assert(file !== undefined);
        compose_ui.replace_syntax(get_translated_status(file), "", config.textarea());
        compose_ui.autosize_textarea(config.textarea());
    });

    return uppy;
}

export function deactivate_upload(config: Config): void {
    // Remove event listeners added for handling uploads.
    $(config.file_input_identifier()).off("change");
    config.banner_container().off("click");
    config.drag_drop_container().off("dragover dragenter drop paste");

    let uppy;

    if (config.mode === "edit") {
        uppy = upload_objects_by_message_edit_row.get(config.row);
    } else if (config.mode === "compose") {
        uppy = compose_upload_object;
    }

    if (!uppy) {
        return;
    }

    try {
        // Uninstall all plugins and close down the Uppy instance.
        // Also runs uppy.cancelAll() before uninstalling - which
        // cancels all uploads, resets progress and removes all files.
        uppy.destroy();
    } catch (error) {
        blueslip.error("Failed to close upload object.", {config}, error);
    }

    if (config.mode === "edit") {
        // Since we removed all the uploads from the row, we should
        // now remove the corresponding upload object from the store.
        upload_objects_by_message_edit_row.delete(config.row);
    }
}

export function initialize(): void {
    compose_upload_object = setup_upload(compose_config);

    $(".app, #navbar-fixed-container").on("dragstart", (event) => {
        if (event.target.nodeName === "IMG") {
            drag_drop_img = event.target;
        } else {
            drag_drop_img = null;
        }
    });

    // Allow the app panel to receive drag/drop events.
    $(".app, #navbar-fixed-container").on("dragover", (event) => {
        event.preventDefault();
    });

    // TODO: Do something visual to hint that drag/drop will work.
    $(".app, #navbar-fixed-container").on("dragenter", (event) => {
        event.preventDefault();
    });

    $(".app, #navbar-fixed-container").on("drop", (event) => {
        event.preventDefault();

        if (event.target.nodeName === "IMG" && event.target === drag_drop_img) {
            drag_drop_img = null;
            return;
        }

        const $drag_drop_edit_containers = $(".message_edit_form form");
        assert(event.originalEvent !== undefined);
        assert(event.originalEvent.dataTransfer !== null);
        const files = event.originalEvent.dataTransfer.files;
        const $last_drag_drop_edit_container = $drag_drop_edit_containers.last();

        // Handlers registered on individual inputs will ensure that
        // drag/dropping directly onto a compose/edit input will put
        // the upload there. Here, we handle drag/drop events that
        // land somewhere else in the center pane.

        if (compose_state.composing()) {
            // Compose box is open; drop there.
            upload_files(compose_upload_object, compose_config, files);
        } else if ($last_drag_drop_edit_container[0] !== undefined) {
            // A message edit box is open; drop there.
            const row_id = rows.get_message_id($last_drag_drop_edit_container[0]);
            const $drag_drop_container = edit_config(row_id).drag_drop_container();
            if ($drag_drop_container.closest("html").length === 0) {
                return;
            }
            const edit_upload_object = upload_objects_by_message_edit_row.get(row_id);
            assert(edit_upload_object !== undefined);

            upload_files(edit_upload_object, edit_config(row_id), files);
        } else if (message_lists.current?.selected_message()) {
            // Start a reply to selected message, if viewing a message feed.
            compose_reply.respond_to_message({
                trigger: "drag_drop_file",
                keep_composebox_empty: true,
            });
            upload_files(compose_upload_object, compose_config, files);
        } else {
            // Start a new message in other views.
            compose_actions.start({
                message_type: "stream",
                trigger: "drag_drop_file",
                keep_composebox_empty: true,
            });
            upload_files(compose_upload_object, compose_config, files);
        }
    });
}
