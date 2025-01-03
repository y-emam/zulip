import time
from collections import defaultdict
from collections.abc import Callable
from typing import Annotated, Any

import orjson
from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.db import transaction
from django.http import HttpRequest, HttpResponse
from django.utils.translation import gettext as _
from django.utils.translation import override as override_language
from pydantic import BaseModel, Field, Json, NonNegativeInt, StringConstraints, model_validator

from zerver.actions.default_streams import (
    do_add_default_stream,
    do_add_streams_to_default_stream_group,
    do_change_default_stream_group_description,
    do_change_default_stream_group_name,
    do_create_default_stream_group,
    do_remove_default_stream,
    do_remove_default_stream_group,
    do_remove_streams_from_default_stream_group,
)
from zerver.actions.message_delete import do_delete_messages
from zerver.actions.message_send import (
    do_send_messages,
    internal_prep_private_message,
    internal_prep_stream_message,
)
from zerver.actions.streams import (
    bulk_add_subscriptions,
    bulk_remove_subscriptions,
    do_change_stream_description,
    do_change_stream_group_based_setting,
    do_change_stream_message_retention_days,
    do_change_stream_permission,
    do_change_stream_post_policy,
    do_change_subscription_property,
    do_deactivate_stream,
    do_rename_stream,
    get_subscriber_ids,
)
from zerver.context_processors import get_valid_realm_from_request
from zerver.decorator import (
    check_if_user_can_manage_default_streams,
    require_non_guest_user,
    require_realm_admin,
)
from zerver.lib.default_streams import get_default_stream_ids_for_realm
from zerver.lib.email_mirror_helpers import encode_email_address
from zerver.lib.exceptions import (
    CannotManageDefaultChannelError,
    JsonableError,
    OrganizationOwnerRequiredError,
)
from zerver.lib.mention import MentionBackend, silent_mention_syntax_for_user
from zerver.lib.message import bulk_access_stream_messages_query
from zerver.lib.response import json_success
from zerver.lib.retention import STREAM_MESSAGE_BATCH_SIZE as RETENTION_STREAM_MESSAGE_BATCH_SIZE
from zerver.lib.retention import parse_message_retention_days
from zerver.lib.stream_traffic import get_streams_traffic
from zerver.lib.streams import (
    StreamDict,
    access_default_stream_group_by_id,
    access_stream_by_id,
    access_stream_by_name,
    access_stream_for_delete_or_update,
    access_web_public_stream,
    check_stream_name_available,
    do_get_streams,
    filter_stream_authorization,
    get_group_setting_value_dict_for_streams,
    get_stream_permission_default_group,
    get_stream_permission_policy_name,
    list_to_streams,
    stream_to_dict,
)
from zerver.lib.subscription_info import gather_subscriptions
from zerver.lib.topic import (
    get_topic_history_for_public_stream,
    get_topic_history_for_stream,
    messages_for_topic,
)
from zerver.lib.typed_endpoint import ApiParamConfig, PathOnly, typed_endpoint
from zerver.lib.typed_endpoint_validators import check_color, check_int_in_validator
from zerver.lib.types import AnonymousSettingGroupDict
from zerver.lib.user_groups import (
    GroupSettingChangeRequest,
    access_user_group_for_setting,
    get_group_setting_value_for_api,
    get_role_based_system_groups_dict,
    parse_group_setting_value,
    validate_group_setting_value_change,
)
from zerver.lib.users import bulk_access_users_by_email, bulk_access_users_by_id
from zerver.lib.utils import assert_is_not_none
from zerver.models import Realm, Stream, UserProfile
from zerver.models.users import get_system_bot


def bulk_principals_to_user_profiles(
    principals: list[str] | list[int],
    acting_user: UserProfile,
) -> set[UserProfile]:
    # Since principals is guaranteed to be non-empty and to have the same type of elements,
    # the following if/else is safe and enough.

    # principals are user emails.
    if isinstance(principals[0], str):
        return bulk_access_users_by_email(
            principals,  # type: ignore[arg-type] # principals guaranteed to be list[str] only.
            acting_user=acting_user,
            allow_deactivated=False,
            allow_bots=True,
            for_admin=False,
        )

    # principals are user ids.
    else:
        return bulk_access_users_by_id(
            principals,  # type: ignore[arg-type] # principals guaranteed to be list[int] only.
            acting_user=acting_user,
            allow_deactivated=False,
            allow_bots=True,
            for_admin=False,
        )


def user_directly_controls_user(user_profile: UserProfile, target: UserProfile) -> bool:
    """Returns whether the target user is either the current user or a bot
    owned by the current user"""
    if user_profile == target:
        return True
    if target.is_bot and target.bot_owner_id == user_profile.id:
        return True
    return False


def deactivate_stream_backend(
    request: HttpRequest, user_profile: UserProfile, stream_id: int
) -> HttpResponse:
    (stream, sub) = access_stream_for_delete_or_update(user_profile, stream_id)
    do_deactivate_stream(stream, acting_user=user_profile)
    return json_success(request)


@check_if_user_can_manage_default_streams
@typed_endpoint
def add_default_stream(
    request: HttpRequest, user_profile: UserProfile, *, stream_id: Json[int]
) -> HttpResponse:
    (stream, sub) = access_stream_by_id(user_profile, stream_id)
    if stream.invite_only:
        raise JsonableError(_("Private channels cannot be made default."))
    do_add_default_stream(stream)
    return json_success(request)


@check_if_user_can_manage_default_streams
@typed_endpoint
def create_default_stream_group(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    group_name: str,
    description: str,
    stream_names: Json[list[str]],
) -> HttpResponse:
    streams = []
    for stream_name in stream_names:
        (stream, sub) = access_stream_by_name(user_profile, stream_name)
        streams.append(stream)
    do_create_default_stream_group(user_profile.realm, group_name, description, streams)
    return json_success(request)


@check_if_user_can_manage_default_streams
@typed_endpoint
def update_default_stream_group_info(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    group_id: PathOnly[int],
    new_group_name: str | None = None,
    new_description: str | None = None,
) -> HttpResponse:
    if not new_group_name and not new_description:
        raise JsonableError(_('You must pass "new_description" or "new_group_name".'))

    group = access_default_stream_group_by_id(user_profile.realm, group_id)
    if new_group_name is not None:
        do_change_default_stream_group_name(user_profile.realm, group, new_group_name)
    if new_description is not None:
        do_change_default_stream_group_description(user_profile.realm, group, new_description)
    return json_success(request)


@check_if_user_can_manage_default_streams
@typed_endpoint
def update_default_stream_group_streams(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    group_id: PathOnly[int],
    op: str,
    stream_names: Json[list[str]],
) -> HttpResponse:
    group = access_default_stream_group_by_id(user_profile.realm, group_id)
    streams = []
    for stream_name in stream_names:
        (stream, sub) = access_stream_by_name(user_profile, stream_name)
        streams.append(stream)

    if op == "add":
        do_add_streams_to_default_stream_group(user_profile.realm, group, streams)
    elif op == "remove":
        do_remove_streams_from_default_stream_group(user_profile.realm, group, streams)
    else:
        raise JsonableError(_('Invalid value for "op". Specify one of "add" or "remove".'))
    return json_success(request)


@check_if_user_can_manage_default_streams
@typed_endpoint
def remove_default_stream_group(
    request: HttpRequest, user_profile: UserProfile, *, group_id: PathOnly[int]
) -> HttpResponse:
    group = access_default_stream_group_by_id(user_profile.realm, group_id)
    do_remove_default_stream_group(user_profile.realm, group)
    return json_success(request)


@check_if_user_can_manage_default_streams
@typed_endpoint
def remove_default_stream(
    request: HttpRequest, user_profile: UserProfile, *, stream_id: Json[int]
) -> HttpResponse:
    (stream, sub) = access_stream_by_id(
        user_profile,
        stream_id,
        allow_realm_admin=True,
    )
    do_remove_default_stream(stream)
    return json_success(request)


@typed_endpoint
def update_stream_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    stream_id: PathOnly[int],
    description: Annotated[str, StringConstraints(max_length=Stream.MAX_DESCRIPTION_LENGTH)]
    | None = None,
    is_private: Json[bool] | None = None,
    is_announcement_only: Json[bool] | None = None,
    is_default_stream: Json[bool] | None = None,
    stream_post_policy: Json[
        Annotated[
            int,
            check_int_in_validator(Stream.STREAM_POST_POLICY_TYPES),
        ]
    ]
    | None = None,
    history_public_to_subscribers: Json[bool] | None = None,
    is_web_public: Json[bool] | None = None,
    new_name: str | None = None,
    message_retention_days: Json[str] | Json[int] | None = None,
    can_administer_channel_group: Json[GroupSettingChangeRequest] | None = None,
    can_remove_subscribers_group: Json[GroupSettingChangeRequest] | None = None,
) -> HttpResponse:
    # We allow realm administrators to update the stream name and
    # description even for private streams.
    (stream, sub) = access_stream_for_delete_or_update(user_profile, stream_id)

    # Validate that the proposed state for permissions settings is permitted.
    if is_private is not None:
        proposed_is_private = is_private
    else:
        proposed_is_private = stream.invite_only

    if is_web_public is not None:
        proposed_is_web_public = is_web_public
    else:
        proposed_is_web_public = stream.is_web_public

    if is_default_stream is not None:
        proposed_is_default_stream = is_default_stream
    else:
        default_stream_ids = get_default_stream_ids_for_realm(stream.realm_id)
        proposed_is_default_stream = stream.id in default_stream_ids

    if stream.realm.is_zephyr_mirror_realm:
        # In the Zephyr mirroring model, history is unconditionally
        # not public to subscribers, even for public streams.
        proposed_history_public_to_subscribers = False
    elif history_public_to_subscribers is not None:
        proposed_history_public_to_subscribers = history_public_to_subscribers
    elif is_private is not None:
        # By default, private streams have protected history while for
        # public streams history is public by default.
        proposed_history_public_to_subscribers = not is_private
    else:
        proposed_history_public_to_subscribers = stream.history_public_to_subscribers

    # Web-public streams must have subscriber-public history.
    if proposed_is_web_public and not proposed_history_public_to_subscribers:
        raise JsonableError(_("Invalid parameters"))

    # Web-public streams must not be private.
    if proposed_is_web_public and proposed_is_private:
        raise JsonableError(_("Invalid parameters"))

    # Public streams must be public to subscribers.
    if not proposed_is_private and not proposed_history_public_to_subscribers:
        if stream.realm.is_zephyr_mirror_realm:
            # All Zephyr realm streams violate this rule.
            pass
        else:
            raise JsonableError(_("Invalid parameters"))

    # Ensure that a stream cannot be both a default stream for new users and private
    if proposed_is_private and proposed_is_default_stream:
        raise JsonableError(_("A default channel cannot be private."))

    # Ensure that a moderation request channel isn't set to public.
    if not proposed_is_private and user_profile.realm.get_moderation_request_channel() == stream:
        raise JsonableError(_("Moderation request channel must be private."))

    if is_private is not None:
        # We require even realm administrators to be actually
        # subscribed to make a private stream public, via this
        # stricted access_stream check.
        access_stream_by_id(user_profile, stream_id)

    # Enforce restrictions on creating web-public streams. Since these
    # checks are only required when changing a stream to be
    # web-public, we don't use an "is not None" check.
    if is_web_public:
        if not user_profile.realm.web_public_streams_enabled():
            raise JsonableError(_("Web-public channels are not enabled."))
        if not user_profile.can_create_web_public_streams():
            raise JsonableError(_("Insufficient permission"))

    if (
        is_private is not None
        or is_web_public is not None
        or history_public_to_subscribers is not None
    ):
        do_change_stream_permission(
            stream,
            invite_only=proposed_is_private,
            history_public_to_subscribers=proposed_history_public_to_subscribers,
            is_web_public=proposed_is_web_public,
            acting_user=user_profile,
        )

    if is_default_stream is not None:
        if not user_profile.can_manage_default_streams():
            raise CannotManageDefaultChannelError
        if is_default_stream:
            do_add_default_stream(stream)
        else:
            do_remove_default_stream(stream)

    if message_retention_days is not None:
        if not user_profile.is_realm_owner:
            raise OrganizationOwnerRequiredError
        user_profile.realm.ensure_not_on_limited_plan()
        new_message_retention_days_value = parse_message_retention_days(
            message_retention_days, Stream.MESSAGE_RETENTION_SPECIAL_VALUES_MAP
        )
        do_change_stream_message_retention_days(
            stream, user_profile, new_message_retention_days_value
        )

    if description is not None:
        if "\n" in description:
            # We don't allow newline characters in stream descriptions.
            description = description.replace("\n", " ")
        do_change_stream_description(stream, description, acting_user=user_profile)
    if new_name is not None:
        new_name = new_name.strip()
        if stream.name == new_name:
            raise JsonableError(_("Channel already has that name."))
        if stream.name.lower() != new_name.lower():
            # Check that the stream name is available (unless we are
            # are only changing the casing of the stream name).
            check_stream_name_available(user_profile.realm, new_name)
        do_rename_stream(stream, new_name, user_profile)
    if is_announcement_only is not None:
        # is_announcement_only is a legacy way to specify
        # stream_post_policy.  We can probably just delete this code,
        # since we're not aware of clients that used it, but we're
        # keeping it for backwards-compatibility for now.
        stream_post_policy = Stream.STREAM_POST_POLICY_EVERYONE
        if is_announcement_only:
            stream_post_policy = Stream.STREAM_POST_POLICY_ADMINS
    if stream_post_policy is not None:
        do_change_stream_post_policy(stream, stream_post_policy, acting_user=user_profile)

    request_settings_dict = locals()
    for setting_name, permission_configuration in Stream.stream_permission_group_settings.items():
        assert setting_name in request_settings_dict
        if request_settings_dict[setting_name] is None:
            continue

        setting_value = request_settings_dict[setting_name]
        new_setting_value = parse_group_setting_value(setting_value.new, setting_name)

        expected_current_setting_value = None
        if setting_value.old is not None:
            expected_current_setting_value = parse_group_setting_value(
                setting_value.old, setting_name
            )

        current_value = getattr(stream, setting_name)
        current_setting_api_value = get_group_setting_value_for_api(current_value)

        if validate_group_setting_value_change(
            current_setting_api_value, new_setting_value, expected_current_setting_value
        ):
            if sub is None and stream.invite_only:
                # Admins cannot change this setting for unsubscribed private streams.
                raise JsonableError(_("Invalid channel ID"))
            with transaction.atomic(durable=True):
                user_group = access_user_group_for_setting(
                    new_setting_value,
                    user_profile,
                    setting_name=setting_name,
                    permission_configuration=permission_configuration,
                    current_setting_value=current_value,
                )
                do_change_stream_group_based_setting(
                    stream,
                    setting_name,
                    user_group,
                    old_setting_api_value=current_setting_api_value,
                    acting_user=user_profile,
                )

    return json_success(request)


@typed_endpoint
def list_subscriptions_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    include_subscribers: Json[bool] = False,
) -> HttpResponse:
    subscribed, _ = gather_subscriptions(
        user_profile,
        include_subscribers=include_subscribers,
    )
    return json_success(request, data={"subscriptions": subscribed})


class AddSubscriptionData(BaseModel):
    name: str
    color: str | None = None
    description: (
        Annotated[str, StringConstraints(max_length=Stream.MAX_DESCRIPTION_LENGTH)] | None
    ) = None

    @model_validator(mode="after")
    def validate_terms(self) -> "AddSubscriptionData":
        if self.color is not None:
            self.color = check_color("add.color", self.color)
        return self


@typed_endpoint
def update_subscriptions_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    delete: Json[list[str]] | None = None,
    add: Json[list[AddSubscriptionData]] | None = None,
) -> HttpResponse:
    if delete is None:
        delete = []
    if add is None:
        add = []
    if not add and not delete:
        raise JsonableError(_('Nothing to do. Specify at least one of "add" or "delete".'))

    thunks = [
        lambda: add_subscriptions_backend(request, user_profile, streams_raw=add),
        lambda: remove_subscriptions_backend(request, user_profile, streams_raw=delete),
    ]
    data = compose_views(thunks)

    return json_success(request, data)


def compose_views(thunks: list[Callable[[], HttpResponse]]) -> dict[str, Any]:
    """
    This takes a series of thunks and calls them in sequence, and it
    smushes all the json results into a single response when
    everything goes right.  (This helps clients avoid extra latency
    hops.)  It rolls back the transaction when things go wrong in any
    one of the composed methods.
    """

    json_dict: dict[str, Any] = {}
    with transaction.atomic(savepoint=False):
        for thunk in thunks:
            response = thunk()
            json_dict.update(orjson.loads(response.content))
    return json_dict


@typed_endpoint
def remove_subscriptions_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    streams_raw: Annotated[Json[list[str]], ApiParamConfig("subscriptions")],
    principals: Json[list[str] | list[int]] | None = None,
) -> HttpResponse:
    realm = user_profile.realm

    streams_as_dict: list[StreamDict] = [
        {"name": stream_name.strip()} for stream_name in streams_raw
    ]

    unsubscribing_others = False
    if principals:
        people_to_unsub = bulk_principals_to_user_profiles(principals, user_profile)
        unsubscribing_others = any(
            not user_directly_controls_user(user_profile, target) for target in people_to_unsub
        )

    else:
        people_to_unsub = {user_profile}

    streams, __ = list_to_streams(
        streams_as_dict,
        user_profile,
        unsubscribing_others=unsubscribing_others,
    )

    result: dict[str, list[str]] = dict(removed=[], not_removed=[])
    (removed, not_subscribed) = bulk_remove_subscriptions(
        realm, people_to_unsub, streams, acting_user=user_profile
    )

    for subscriber, removed_stream in removed:
        result["removed"].append(removed_stream.name)
    for subscriber, not_subscribed_stream in not_subscribed:
        result["not_removed"].append(not_subscribed_stream.name)

    return json_success(request, data=result)


def you_were_just_subscribed_message(
    acting_user: UserProfile, recipient_user: UserProfile, stream_names: set[str]
) -> str:
    subscriptions = sorted(stream_names)
    if len(subscriptions) == 1:
        with override_language(recipient_user.default_language):
            return _("{user_full_name} subscribed you to the channel {channel_name}.").format(
                user_full_name=f"@**{acting_user.full_name}|{acting_user.id}**",
                channel_name=f"#**{subscriptions[0]}**",
            )

    with override_language(recipient_user.default_language):
        message = _("{user_full_name} subscribed you to the following channels:").format(
            user_full_name=f"@**{acting_user.full_name}|{acting_user.id}**",
        )
    message += "\n\n"
    for channel_name in subscriptions:
        message += f"* #**{channel_name}**\n"
    return message


RETENTION_DEFAULT: str | int = "realm_default"


@transaction.atomic(savepoint=False)
@require_non_guest_user
@typed_endpoint
def add_subscriptions_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    streams_raw: Annotated[Json[list[AddSubscriptionData]], ApiParamConfig("subscriptions")],
    invite_only: Json[bool] = False,
    is_web_public: Json[bool] = False,
    is_default_stream: Json[bool] = False,
    stream_post_policy: Json[
        Annotated[int, check_int_in_validator(Stream.STREAM_POST_POLICY_TYPES)]
    ] = Stream.STREAM_POST_POLICY_EVERYONE,
    history_public_to_subscribers: Json[bool] | None = None,
    message_retention_days: Json[str] | Json[int] = RETENTION_DEFAULT,
    can_administer_channel_group: Json[int | AnonymousSettingGroupDict] | None = None,
    can_remove_subscribers_group: Json[int | AnonymousSettingGroupDict] | None = None,
    announce: Json[bool] = False,
    principals: Json[list[str] | list[int]] | None = None,
    authorization_errors_fatal: Json[bool] = True,
) -> HttpResponse:
    realm = user_profile.realm
    stream_dicts = []
    color_map = {}
    # UserProfile ids or emails.
    if principals is None:
        principals = []

    setting_groups_dict = {}
    group_settings_map = {}
    request_settings_dict = locals()
    # We don't want to calculate this value if no default values are
    # needed.
    system_groups_name_dict = None
    for setting_name, permission_configuration in Stream.stream_permission_group_settings.items():
        assert setting_name in request_settings_dict
        if request_settings_dict[setting_name] is not None:
            setting_request_value = request_settings_dict[setting_name]
            setting_value = parse_group_setting_value(setting_request_value, setting_name)
            group_settings_map[setting_name] = access_user_group_for_setting(
                setting_value,
                user_profile,
                setting_name=setting_name,
                permission_configuration=permission_configuration,
            )
            setting_groups_dict[group_settings_map[setting_name].id] = setting_value
        else:
            if system_groups_name_dict is None:
                system_groups_name_dict = get_role_based_system_groups_dict(realm)
            group_settings_map[setting_name] = get_stream_permission_default_group(
                setting_name, system_groups_name_dict, creator=user_profile
            )
            setting_groups_dict[group_settings_map[setting_name].id] = group_settings_map[
                setting_name
            ].id

    for stream_obj in streams_raw:
        # 'color' field is optional
        # check for its presence in the streams_raw first
        if stream_obj.color is not None:
            color_map[stream_obj.name] = stream_obj.color

        stream_dict_copy: StreamDict = {}
        stream_dict_copy["name"] = stream_obj.name.strip()

        # We don't allow newline characters in stream descriptions.
        if stream_obj.description is not None:
            stream_dict_copy["description"] = stream_obj.description.replace("\n", " ")

        stream_dict_copy["invite_only"] = invite_only
        stream_dict_copy["is_web_public"] = is_web_public
        stream_dict_copy["stream_post_policy"] = stream_post_policy
        stream_dict_copy["history_public_to_subscribers"] = history_public_to_subscribers
        stream_dict_copy["message_retention_days"] = parse_message_retention_days(
            message_retention_days, Stream.MESSAGE_RETENTION_SPECIAL_VALUES_MAP
        )
        stream_dict_copy["can_administer_channel_group"] = group_settings_map[
            "can_administer_channel_group"
        ]
        stream_dict_copy["can_remove_subscribers_group"] = group_settings_map[
            "can_remove_subscribers_group"
        ]

        stream_dicts.append(stream_dict_copy)

    is_subscribing_other_users = False
    if len(principals) > 0 and not all(user_id == user_profile.id for user_id in principals):
        is_subscribing_other_users = True

    if is_subscribing_other_users:
        if not user_profile.can_subscribe_other_users():
            # Guest users case will not be handled here as it will
            # be handled by the decorator above.
            raise JsonableError(_("Insufficient permission"))
        subscribers = bulk_principals_to_user_profiles(principals, user_profile)

    else:
        subscribers = {user_profile}

    # Validation of the streams arguments, including enforcement of
    # can_create_streams policy and check_stream_name policy is inside
    # list_to_streams.
    existing_streams, created_streams = list_to_streams(
        stream_dicts,
        user_profile,
        autocreate=True,
        is_default_stream=is_default_stream,
        setting_groups_dict=setting_groups_dict,
    )
    authorized_streams, unauthorized_streams = filter_stream_authorization(
        user_profile, existing_streams
    )
    if len(unauthorized_streams) > 0 and authorization_errors_fatal:
        raise JsonableError(
            _("Unable to access channel ({channel_name}).").format(
                channel_name=unauthorized_streams[0].name,
            )
        )
    # Newly created streams are also authorized for the creator
    streams = authorized_streams + created_streams

    if (
        is_subscribing_other_users
        and realm.is_zephyr_mirror_realm
        and not all(stream.invite_only for stream in streams)
    ):
        raise JsonableError(
            _("You can only invite other Zephyr mirroring users to private channels.")
        )

    if is_default_stream:
        for stream in created_streams:
            do_add_default_stream(stream)

    (subscribed, already_subscribed) = bulk_add_subscriptions(
        realm, streams, subscribers, acting_user=user_profile, color_map=color_map
    )

    id_to_user_profile: dict[str, UserProfile] = {}

    result: dict[str, Any] = dict(
        subscribed=defaultdict(list), already_subscribed=defaultdict(list)
    )
    for sub_info in subscribed:
        subscriber = sub_info.user
        stream = sub_info.stream
        user_id = str(subscriber.id)
        result["subscribed"][user_id].append(stream.name)
        id_to_user_profile[user_id] = subscriber
    for sub_info in already_subscribed:
        subscriber = sub_info.user
        stream = sub_info.stream
        user_id = str(subscriber.id)
        result["already_subscribed"][user_id].append(stream.name)

    result["subscribed"] = dict(result["subscribed"])
    result["already_subscribed"] = dict(result["already_subscribed"])

    send_messages_for_new_subscribers(
        user_profile=user_profile,
        subscribers=subscribers,
        new_subscriptions=result["subscribed"],
        id_to_user_profile=id_to_user_profile,
        created_streams=created_streams,
        announce=announce,
    )

    result["subscribed"] = dict(result["subscribed"])
    result["already_subscribed"] = dict(result["already_subscribed"])
    if not authorization_errors_fatal:
        result["unauthorized"] = [s.name for s in unauthorized_streams]
    return json_success(request, data=result)


def send_messages_for_new_subscribers(
    user_profile: UserProfile,
    subscribers: set[UserProfile],
    new_subscriptions: dict[str, list[str]],
    id_to_user_profile: dict[str, UserProfile],
    created_streams: list[Stream],
    announce: bool,
) -> None:
    """
    If you are subscribing lots of new users to new streams,
    this function can be pretty expensive in terms of generating
    lots of queries and sending lots of messages.  We isolate
    the code partly to make it easier to test things like
    excessive query counts by mocking this function so that it
    doesn't drown out query counts from other code.
    """
    bots = {str(subscriber.id): subscriber.is_bot for subscriber in subscribers}

    newly_created_stream_names = {s.name for s in created_streams}

    realm = user_profile.realm
    mention_backend = MentionBackend(realm.id)

    # Inform the user if someone else subscribed them to stuff,
    # or if a new stream was created with the "announce" option.
    notifications = []
    if new_subscriptions:
        for id, subscribed_stream_names in new_subscriptions.items():
            if id == str(user_profile.id):
                # Don't send a Zulip if you invited yourself.
                continue
            if bots[id]:
                # Don't send invitation Zulips to bots
                continue

            # For each user, we notify them about newly subscribed streams, except for
            # streams that were newly created.
            notify_stream_names = set(subscribed_stream_names) - newly_created_stream_names

            if not notify_stream_names:
                continue

            recipient_user = id_to_user_profile[id]
            sender = get_system_bot(settings.NOTIFICATION_BOT, recipient_user.realm_id)

            msg = you_were_just_subscribed_message(
                acting_user=user_profile,
                recipient_user=recipient_user,
                stream_names=notify_stream_names,
            )

            notifications.append(
                internal_prep_private_message(
                    sender=sender,
                    recipient_user=recipient_user,
                    content=msg,
                    mention_backend=mention_backend,
                )
            )

    if announce and len(created_streams) > 0:
        new_stream_announcements_stream = user_profile.realm.get_new_stream_announcements_stream()
        if new_stream_announcements_stream is not None:
            with override_language(new_stream_announcements_stream.realm.default_language):
                if len(created_streams) > 1:
                    content = _("{user_name} created the following channels: {new_channels}.")
                else:
                    content = _("{user_name} created a new channel {new_channels}.")
                topic_name = _("new channels")

            content = content.format(
                user_name=silent_mention_syntax_for_user(user_profile),
                new_channels=", ".join(f"#**{s.name}**" for s in created_streams),
            )

            sender = get_system_bot(
                settings.NOTIFICATION_BOT, new_stream_announcements_stream.realm_id
            )

            notifications.append(
                internal_prep_stream_message(
                    sender=sender,
                    stream=new_stream_announcements_stream,
                    topic_name=topic_name,
                    content=content,
                ),
            )

    if not user_profile.realm.is_zephyr_mirror_realm and len(created_streams) > 0:
        sender = get_system_bot(settings.NOTIFICATION_BOT, user_profile.realm_id)
        for stream in created_streams:
            with override_language(stream.realm.default_language):
                if stream.description == "":
                    stream_description = "*" + _("No description.") + "*"
                else:
                    stream_description = stream.description
                notifications.append(
                    internal_prep_stream_message(
                        sender=sender,
                        stream=stream,
                        topic_name=str(Realm.STREAM_EVENTS_NOTIFICATION_TOPIC_NAME),
                        content=_(
                            "**{policy}** channel created by {user_name}. **Description:**"
                        ).format(
                            user_name=silent_mention_syntax_for_user(user_profile),
                            policy=get_stream_permission_policy_name(
                                invite_only=stream.invite_only,
                                history_public_to_subscribers=stream.history_public_to_subscribers,
                                is_web_public=stream.is_web_public,
                            ),
                        )
                        + f"\n```` quote\n{stream_description}\n````",
                    ),
                )

    if len(notifications) > 0:
        do_send_messages(notifications, mark_as_read=[user_profile.id])


@typed_endpoint
def get_subscribers_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    stream_id: Annotated[NonNegativeInt, ApiParamConfig("stream", path_only=True)],
) -> HttpResponse:
    (stream, sub) = access_stream_by_id(
        user_profile,
        stream_id,
        allow_realm_admin=True,
    )
    subscribers = get_subscriber_ids(stream, user_profile)

    return json_success(request, data={"subscribers": list(subscribers)})


# By default, lists all streams that the user has access to --
# i.e. public streams plus invite-only streams that the user is on
@typed_endpoint
def get_streams_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    include_public: Json[bool] = True,
    include_web_public: Json[bool] = False,
    include_subscribed: Json[bool] = True,
    exclude_archived: Json[bool] = True,
    include_all_active: Json[bool] = False,
    include_default: Json[bool] = False,
    include_owner_subscribed: Json[bool] = False,
) -> HttpResponse:
    streams = do_get_streams(
        user_profile,
        include_public=include_public,
        include_web_public=include_web_public,
        include_subscribed=include_subscribed,
        exclude_archived=exclude_archived,
        include_all_active=include_all_active,
        include_default=include_default,
        include_owner_subscribed=include_owner_subscribed,
    )
    return json_success(request, data={"streams": streams})


@typed_endpoint
def get_stream_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    stream_id: PathOnly[int],
) -> HttpResponse:
    (stream, sub) = access_stream_by_id(user_profile, stream_id, allow_realm_admin=True)

    recent_traffic = get_streams_traffic({stream.id}, user_profile.realm)
    setting_groups_dict = get_group_setting_value_dict_for_streams([stream])

    return json_success(
        request, data={"stream": stream_to_dict(stream, recent_traffic, setting_groups_dict)}
    )


@typed_endpoint
def get_topics_backend(
    request: HttpRequest,
    maybe_user_profile: UserProfile | AnonymousUser,
    *,
    stream_id: PathOnly[NonNegativeInt],
) -> HttpResponse:
    if not maybe_user_profile.is_authenticated:
        is_web_public_query = True
        user_profile: UserProfile | None = None
    else:
        is_web_public_query = False
        assert isinstance(maybe_user_profile, UserProfile)
        user_profile = maybe_user_profile
        assert user_profile is not None

    if is_web_public_query:
        realm = get_valid_realm_from_request(request)
        stream = access_web_public_stream(stream_id, realm)
        result = get_topic_history_for_public_stream(
            realm_id=realm.id, recipient_id=assert_is_not_none(stream.recipient_id)
        )

    else:
        assert user_profile is not None

        (stream, sub) = access_stream_by_id(user_profile, stream_id)

        assert stream.recipient_id is not None
        result = get_topic_history_for_stream(
            user_profile=user_profile,
            recipient_id=stream.recipient_id,
            public_history=stream.is_history_public_to_subscribers(),
        )

    return json_success(request, data=dict(topics=result))


@require_realm_admin
@typed_endpoint
def delete_in_topic(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    stream_id: PathOnly[NonNegativeInt],
    topic_name: str,
) -> HttpResponse:
    stream, ignored_sub = access_stream_by_id(user_profile, stream_id)

    messages = messages_for_topic(
        user_profile.realm_id, assert_is_not_none(stream.recipient_id), topic_name
    )
    # This handles applying access control, such that only messages
    # the user can see are returned in the query.
    messages = bulk_access_stream_messages_query(user_profile, messages, stream)

    # Topics can be large enough that this request will inevitably time out.
    # In such a case, it's good for some progress to be accomplished, so that
    # full deletion can be achieved by repeating the request. For that purpose,
    # we delete messages in atomic batches, committing after each batch.
    # TODO: Ideally this should be moved to the deferred_work queue.
    start_time = time.monotonic()
    batch_size = RETENTION_STREAM_MESSAGE_BATCH_SIZE
    while True:
        if time.monotonic() >= start_time + 50:
            return json_success(request, data={"complete": False})
        with transaction.atomic(durable=True):
            messages_to_delete = messages.order_by("-id")[0:batch_size].select_for_update(
                of=("self",)
            )
            if not messages_to_delete:
                break
            do_delete_messages(user_profile.realm, messages_to_delete, acting_user=user_profile)

    return json_success(request, data={"complete": True})


@typed_endpoint
def json_get_stream_id(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    stream_name: Annotated[str, ApiParamConfig("stream")],
) -> HttpResponse:
    (stream, sub) = access_stream_by_name(user_profile, stream_name)
    return json_success(request, data={"stream_id": stream.id})


class SubscriptionPropertyChangeRequest(BaseModel):
    stream_id: int
    property: str
    value: bool | str

    @model_validator(mode="after")
    def validate_terms(self) -> "SubscriptionPropertyChangeRequest":
        boolean_properties = {
            "in_home_view",
            "is_muted",
            "desktop_notifications",
            "audible_notifications",
            "push_notifications",
            "email_notifications",
            "pin_to_top",
            "wildcard_mentions_notify",
        }

        if self.property == "color":
            self.value = check_color("color", self.value)
        elif self.property in boolean_properties:
            if not isinstance(self.value, bool):
                raise JsonableError(_("{property} is not a boolean").format(property=self.property))
        else:
            raise JsonableError(
                _("Unknown subscription property: {property}").format(property=self.property)
            )
        return self


@typed_endpoint
def update_subscriptions_property(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    stream_id: PathOnly[Json[int]],
    property: str,
    value: Annotated[Json[bool] | str, Field(union_mode="left_to_right")],
) -> HttpResponse:
    change_request = SubscriptionPropertyChangeRequest(
        stream_id=stream_id, property=property, value=value
    )
    return update_subscription_properties_backend(
        request, user_profile, subscription_data=[change_request]
    )


@typed_endpoint
def update_subscription_properties_backend(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    subscription_data: Json[list[SubscriptionPropertyChangeRequest]],
) -> HttpResponse:
    """
    This is the entry point to changing subscription properties. This
    is a bulk endpoint: requesters always provide a subscription_data
    list containing dictionaries for each stream of interest.

    Requests are of the form:

    [{"stream_id": "1", "property": "is_muted", "value": False},
     {"stream_id": "1", "property": "color", "value": "#c2c2c2"}]
    """

    for change in subscription_data:
        stream_id = change.stream_id
        property = change.property
        value = change.value

        (stream, sub) = access_stream_by_id(user_profile, stream_id)
        if sub is None:
            raise JsonableError(
                _("Not subscribed to channel ID {channel_id}").format(channel_id=stream_id)
            )

        do_change_subscription_property(
            user_profile, sub, stream, property, value, acting_user=user_profile
        )

    return json_success(request)


@typed_endpoint
def get_stream_email_address(
    request: HttpRequest,
    user_profile: UserProfile,
    *,
    stream_id: Annotated[NonNegativeInt, ApiParamConfig("stream", path_only=True)],
) -> HttpResponse:
    (stream, sub) = access_stream_by_id(
        user_profile,
        stream_id,
    )
    stream_email = encode_email_address(stream, show_sender=True)

    return json_success(request, data={"email": stream_email})
