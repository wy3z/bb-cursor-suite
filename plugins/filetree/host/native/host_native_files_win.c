#define NAPI_VERSION 8
#ifdef _WIN32_WINNT
#undef _WIN32_WINNT
#endif
#define _WIN32_WINNT 0x0A00
#ifdef WINVER
#undef WINVER
#endif
#define WINVER 0x0A00
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include <winternl.h>
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#ifndef FILE_OPEN
#define FILE_OPEN 0x00000001
#endif
#ifndef FILE_SYNCHRONOUS_IO_NONALERT
#define FILE_SYNCHRONOUS_IO_NONALERT 0x00000020
#endif
#ifndef FILE_DIRECTORY_FILE
#define FILE_DIRECTORY_FILE 0x00000001
#endif
#ifndef FILE_OPEN_REPARSE_POINT
#define FILE_OPEN_REPARSE_POINT 0x00200000
#endif
#ifndef OBJ_CASE_INSENSITIVE
#define OBJ_CASE_INSENSITIVE 0x00000040L
#endif
#ifndef ERROR_STOPPED_ON_SYMLINK
#define ERROR_STOPPED_ON_SYMLINK 681L
#endif
#ifndef ERROR_CANT_RESOLVE_FILENAME
#define ERROR_CANT_RESOLVE_FILENAME 1921L
#endif

#define SHARE_ALL (FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
#define DIR_SLOTS 256
#define GIT_SLOTS 64
#define DIR_BUFFER_SIZE (64 * 1024)
#define READ_CHUNK ((size_t)1048576)
#define WINDOWS_TICK_UNIX_EPOCH 116444736000000000ULL

typedef NTSTATUS(NTAPI *NtCreateFileFn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
                                        PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG,
                                        ULONG, ULONG, ULONG, PVOID, ULONG);
typedef ULONG(NTAPI *RtlNtStatusToDosErrorFn)(NTSTATUS);

static NtCreateFileFn nt_create_file = NULL;
static RtlNtStatusToDosErrorFn rtl_nt_status_to_dos_error = NULL;

typedef struct {
  const char *code;
  const char *message;
} ErrorInfo;

static const ErrorInfo E_NOENT = {"ENOENT", "No such file or directory"};
static const ErrorInfo E_NOTDIR = {"ENOTDIR", "Not a directory"};
static const ErrorInfo E_LOOP = {"ELOOP", "Too many levels of symbolic links"};
static const ErrorInfo E_INVAL = {"EINVAL", "Invalid argument"};
static const ErrorInfo E_ACCES = {"EACCES", "Permission denied"};
static const ErrorInfo E_PERM = {"EPERM", "Operation not permitted"};
static const ErrorInfo E_MFILE = {"EMFILE", "Too many open files"};
static const ErrorInfo E_NOTSUP = {"ENOTSUP", "Operation not supported"};
static const ErrorInfo E_NOMEM = {"ENOMEM", "Not enough memory"};
static const ErrorInfo E_BADF = {"EBADF", "Bad file descriptor"};
static const ErrorInfo E_IO = {"EIO", "Input/output error"};

typedef struct {
  int used;
  HANDLE handle;
  unsigned char *buffer;
  DWORD offset;
  bool has_data;
  bool started;
  bool done;
} DirSlot;

typedef struct {
  HANDLE pipe;
  HANDLE job;
  unsigned char *buffer;
  size_t length;
  size_t max_bytes;
  volatile LONG *overflow;
} PipeReader;

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  int slot;
  uint64_t generation;
  HANDLE dir;
  wchar_t *file;
  wchar_t *command_line;
  wchar_t *environment;
  int timeout_ms;
  size_t max_bytes;
  volatile LONG cancelled;
  HANDLE job;
  int code;
  unsigned char *stdout_buf;
  size_t stdout_len;
  unsigned char *stderr_buf;
  size_t stderr_len;
  DWORD error_win32;
  char error_msg[160];
  bool failed;
  bool cancelled_result;
} GitRequest;

typedef struct {
  wchar_t *data;
  size_t length;
  size_t capacity;
  bool failed;
} WideBuilder;

static DirSlot dir_slots[DIR_SLOTS];
static GitRequest *git_slots[GIT_SLOTS];
static SRWLOCK git_lock = SRWLOCK_INIT;
static volatile LONG64 git_generation = 1;

static ErrorInfo win32_error_info(DWORD err) {
  switch (err) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
    case ERROR_BAD_NETPATH:
    case ERROR_BAD_NET_NAME:
    case ERROR_INVALID_DRIVE:
    case ERROR_BAD_PATHNAME:
    case ERROR_DELETE_PENDING:
      return E_NOENT;
    case ERROR_DIRECTORY:
      return E_NOTDIR;
    case ERROR_STOPPED_ON_SYMLINK:
    case ERROR_CANT_RESOLVE_FILENAME:
      return E_LOOP;
    case ERROR_INVALID_NAME:
    case ERROR_INVALID_PARAMETER:
    case ERROR_FILENAME_EXCED_RANGE:
      return E_INVAL;
    case ERROR_ACCESS_DENIED:
    case ERROR_SHARING_VIOLATION:
    case ERROR_LOCK_VIOLATION:
      return E_ACCES;
    case ERROR_PRIVILEGE_NOT_HELD:
      return E_PERM;
    case ERROR_TOO_MANY_OPEN_FILES:
      return E_MFILE;
    case ERROR_NOT_SUPPORTED:
    case ERROR_INVALID_FUNCTION:
    case ERROR_CALL_NOT_IMPLEMENTED:
      return E_NOTSUP;
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY:
      return E_NOMEM;
    case ERROR_INVALID_HANDLE:
      return E_BADF;
    default:
      return E_IO;
  }
}

static DWORD status_to_win32(NTSTATUS status) {
  if (rtl_nt_status_to_dos_error == NULL) return ERROR_GEN_FAILURE;
  return (DWORD)rtl_nt_status_to_dos_error(status);
}

static napi_value throw_info(napi_env env, const char *syscall, ErrorInfo info) {
  char message[256];
  snprintf(message, sizeof(message), "%s: %s", syscall, info.message);
  napi_value code_val;
  napi_value message_val;
  napi_value error;
  napi_create_string_utf8(env, info.code, NAPI_AUTO_LENGTH, &code_val);
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_val);
  napi_create_error(env, code_val, message_val, &error);
  napi_set_named_property(env, error, "code", code_val);
  napi_throw(env, error);
  return NULL;
}

static napi_value throw_win32(napi_env env, const char *syscall, DWORD err) {
  ErrorInfo info = win32_error_info(err);
  char message[160];
  snprintf(message, sizeof(message), "%s (Windows error %lu)", info.message, (unsigned long)err);
  info.message = message;
  return throw_info(env, syscall, info);
}

static int get_handle_arg(napi_env env, napi_value value, HANDLE *handle) {
  int64_t parsed = 0;
  if (napi_get_value_int64(env, value, &parsed) != napi_ok) {
    napi_throw_type_error(env, NULL, "handle must be a number");
    return -1;
  }
  if (parsed <= 0 || parsed > INT32_MAX) {
    throw_info(env, "handle", E_BADF);
    return -1;
  }
  *handle = (HANDLE)(intptr_t)parsed;
  return 0;
}

static int get_slot_arg(napi_env env, napi_value value, int *slot) {
  int64_t parsed = 0;
  if (napi_get_value_int64(env, value, &parsed) != napi_ok) {
    napi_throw_type_error(env, NULL, "dirId must be a number");
    return -1;
  }
  if (parsed < 0 || parsed >= DIR_SLOTS) {
    throw_info(env, "dirId", E_INVAL);
    return -1;
  }
  *slot = (int)parsed;
  return 0;
}

static napi_value handle_value(napi_env env, HANDLE handle) {
  napi_value result;
  napi_create_int64(env, (int64_t)(intptr_t)handle, &result);
  return result;
}

static napi_value undefined_value(napi_env env) {
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static wchar_t *get_wide_string(napi_env env, napi_value value, size_t *length_out) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok) return NULL;
  wchar_t *buffer = malloc((length + 1) * sizeof(wchar_t));
  if (buffer == NULL) return NULL;
  if (napi_get_value_string_utf16(env, value, (char16_t *)buffer, length + 1, &length) !=
      napi_ok) {
    free(buffer);
    return NULL;
  }
  buffer[length] = L'\0';
  if (length_out != NULL) *length_out = length;
  return buffer;
}

static bool valid_component(const wchar_t *name, size_t length) {
  if (length == 0 || length > 32767) return false;
  if (name[0] == L'.' && (length == 1 || (length == 2 && name[1] == L'.'))) return false;
  for (size_t index = 0; index < length; index += 1) {
    wchar_t c = name[index];
    if (c == L'\0' || c == L'/' || c == L'\\' || c == L':') return false;
  }
  return true;
}

static bool same_file(const BY_HANDLE_FILE_INFORMATION *left,
                      const BY_HANDLE_FILE_INFORMATION *right) {
  return left->dwVolumeSerialNumber == right->dwVolumeSerialNumber &&
         left->nFileIndexHigh == right->nFileIndexHigh &&
         left->nFileIndexLow == right->nFileIndexLow;
}

static bool same_file_id(HANDLE left, HANDLE right) {
  FILE_ID_INFO a;
  FILE_ID_INFO b;
  if (!GetFileInformationByHandleEx(left, FileIdInfo, &a, sizeof(a)) ||
      !GetFileInformationByHandleEx(right, FileIdInfo, &b, sizeof(b))) {
    return false;
  }
  return a.VolumeSerialNumber == b.VolumeSerialNumber &&
         memcmp(&a.FileId, &b.FileId, sizeof(a.FileId)) == 0;
}

static DWORD reopen_same(HANDLE handle, ACCESS_MASK access, ULONG share, ULONG options,
                         HANDLE *out) {
  DWORD first = ERROR_NOT_SUPPORTED;
  if (nt_create_file != NULL) {
    UNICODE_STRING empty;
    empty.Length = 0;
    empty.MaximumLength = 0;
    empty.Buffer = NULL;
    OBJECT_ATTRIBUTES attributes;
    InitializeObjectAttributes(&attributes, &empty, 0, handle, NULL);
    IO_STATUS_BLOCK io;
    memset(&io, 0, sizeof(io));
    HANDLE reopened = NULL;
    NTSTATUS status = nt_create_file(&reopened, access | SYNCHRONIZE | FILE_READ_ATTRIBUTES,
                                     &attributes, &io, NULL, 0, share, FILE_OPEN,
                                     options | FILE_SYNCHRONOUS_IO_NONALERT, NULL, 0);
    if (status >= 0) {
      *out = reopened;
      return ERROR_SUCCESS;
    }
    first = status_to_win32(status);
  }
  FILE_ID_INFO id;
  if (GetFileInformationByHandleEx(handle, FileIdInfo, &id, sizeof(id))) {
    FILE_ID_DESCRIPTOR descriptor;
    memset(&descriptor, 0, sizeof(descriptor));
    descriptor.dwSize = sizeof(descriptor);
    descriptor.Type = ExtendedFileIdType;
    descriptor.ExtendedFileId = id.FileId;
    DWORD flags = FILE_FLAG_BACKUP_SEMANTICS;
    if ((options & FILE_OPEN_REPARSE_POINT) != 0) flags |= FILE_FLAG_OPEN_REPARSE_POINT;
    HANDLE reopened = OpenFileById(handle, &descriptor, access | SYNCHRONIZE | FILE_READ_ATTRIBUTES,
                                   share, NULL, flags);
    if (reopened != INVALID_HANDLE_VALUE) {
      if (same_file_id(handle, reopened)) {
        *out = reopened;
        return ERROR_SUCCESS;
      }
      CloseHandle(reopened);
    }
  }
  return first;
}

static DWORD settle_reparse(HANDLE *handle) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  if (!GetFileInformationByHandleEx(*handle, FileAttributeTagInfo, &tag, sizeof(tag))) {
    return GetLastError();
  }
  if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) return ERROR_SUCCESS;
  if (IsReparseTagNameSurrogate(tag.ReparseTag)) return ERROR_STOPPED_ON_SYMLINK;
  BY_HANDLE_FILE_INFORMATION before;
  BY_HANDLE_FILE_INFORMATION after;
  if (!GetFileInformationByHandle(*handle, &before)) return GetLastError();
  HANDLE reopened = NULL;
  DWORD err = reopen_same(*handle, FILE_GENERIC_READ, SHARE_ALL, 0, &reopened);
  if (err != ERROR_SUCCESS) return err;
  if (!GetFileInformationByHandle(reopened, &after)) {
    err = GetLastError();
    CloseHandle(reopened);
    return err;
  }
  if (!same_file(&before, &after)) {
    CloseHandle(reopened);
    return ERROR_STOPPED_ON_SYMLINK;
  }
  CloseHandle(*handle);
  *handle = reopened;
  return ERROR_SUCCESS;
}

static DWORD open_beneath(HANDLE dir, const wchar_t *name, size_t length, HANDLE *out) {
  if (nt_create_file == NULL) return ERROR_NOT_SUPPORTED;
  UNICODE_STRING object_name;
  object_name.Length = (USHORT)(length * sizeof(wchar_t));
  object_name.MaximumLength = object_name.Length;
  object_name.Buffer = (PWSTR)name;
  OBJECT_ATTRIBUTES attributes;
  InitializeObjectAttributes(&attributes, &object_name, OBJ_CASE_INSENSITIVE, dir, NULL);
  IO_STATUS_BLOCK io;
  memset(&io, 0, sizeof(io));
  HANDLE handle = NULL;
  NTSTATUS status = nt_create_file(&handle, FILE_GENERIC_READ, &attributes, &io, NULL, 0,
                                   SHARE_ALL, FILE_OPEN,
                                   FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
                                   NULL, 0);
  if (status < 0) return status_to_win32(status);
  DWORD err = settle_reparse(&handle);
  if (err != ERROR_SUCCESS) {
    CloseHandle(handle);
    return err;
  }
  *out = handle;
  return ERROR_SUCCESS;
}

static wchar_t *final_path(HANDLE handle, DWORD *err_out) {
  DWORD flags[2] = {FILE_NAME_NORMALIZED | VOLUME_NAME_DOS, FILE_NAME_OPENED | VOLUME_NAME_DOS};
  for (int attempt = 0; attempt < 2; attempt += 1) {
    DWORD needed = GetFinalPathNameByHandleW(handle, NULL, 0, flags[attempt]);
    if (needed == 0) {
      *err_out = GetLastError();
      continue;
    }
    wchar_t *buffer = malloc(((size_t)needed + 1) * sizeof(wchar_t));
    if (buffer == NULL) {
      *err_out = ERROR_NOT_ENOUGH_MEMORY;
      return NULL;
    }
    DWORD written = GetFinalPathNameByHandleW(handle, buffer, needed + 1, flags[attempt]);
    if (written == 0 || written > needed) {
      *err_out = written == 0 ? GetLastError() : ERROR_INSUFFICIENT_BUFFER;
      free(buffer);
      continue;
    }
    buffer[written] = L'\0';
    if (wcsncmp(buffer, L"\\\\?\\UNC\\", 8) == 0) {
      memmove(buffer + 2, buffer + 8, ((size_t)written - 8 + 1) * sizeof(wchar_t));
    } else if (wcsncmp(buffer, L"\\\\?\\", 4) == 0) {
      memmove(buffer, buffer + 4, ((size_t)written - 4 + 1) * sizeof(wchar_t));
    }
    return buffer;
  }
  return NULL;
}

static napi_value Open(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 2) {
    napi_throw_type_error(env, NULL, "open(path, flags)");
    return NULL;
  }
  int64_t flags = 0;
  if (napi_get_value_int64(env, args[1], &flags) != napi_ok) {
    napi_throw_type_error(env, NULL, "flags must be a number");
    return NULL;
  }
  size_t length = 0;
  wchar_t *path = get_wide_string(env, args[0], &length);
  if (path == NULL) {
    napi_throw_type_error(env, NULL, "path must be a string");
    return NULL;
  }
  if (length == 0 || wcslen(path) != length) {
    free(path);
    return throw_info(env, "open", E_INVAL);
  }
  HANDLE handle = CreateFileW(path, FILE_GENERIC_READ, SHARE_ALL, NULL, OPEN_EXISTING,
                              FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  DWORD err = handle == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
  free(path);
  if (handle == INVALID_HANDLE_VALUE) return throw_win32(env, "open", err);
  err = settle_reparse(&handle);
  if (err != ERROR_SUCCESS) {
    CloseHandle(handle);
    return throw_win32(env, "open", err);
  }
  return handle_value(env, handle);
}

static napi_value Openat(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 3) {
    napi_throw_type_error(env, NULL, "openat(dirfd, name, flags)");
    return NULL;
  }
  HANDLE dir = NULL;
  if (get_handle_arg(env, args[0], &dir) != 0) return NULL;
  int64_t flags = 0;
  if (napi_get_value_int64(env, args[2], &flags) != napi_ok) {
    napi_throw_type_error(env, NULL, "flags must be a number");
    return NULL;
  }
  size_t length = 0;
  wchar_t *name = get_wide_string(env, args[1], &length);
  if (name == NULL) {
    napi_throw_type_error(env, NULL, "name must be a string");
    return NULL;
  }
  if (!valid_component(name, length)) {
    free(name);
    return throw_info(env, "openat", E_INVAL);
  }
  HANDLE handle = NULL;
  DWORD err = open_beneath(dir, name, length, &handle);
  free(name);
  if (err != ERROR_SUCCESS) return throw_win32(env, "openat", err);
  return handle_value(env, handle);
}

static napi_value Dup(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "dup(fd)");
    return NULL;
  }
  HANDLE handle = NULL;
  if (get_handle_arg(env, args[0], &handle) != 0) return NULL;
  HANDLE duplicate = NULL;
  if (!DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &duplicate, 0, FALSE,
                       DUPLICATE_SAME_ACCESS)) {
    return throw_win32(env, "dup", GetLastError());
  }
  return handle_value(env, duplicate);
}

static napi_value CloseFd(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "close(fd)");
    return NULL;
  }
  HANDLE handle = NULL;
  if (get_handle_arg(env, args[0], &handle) != 0) return NULL;
  if (!CloseHandle(handle)) return throw_win32(env, "close", GetLastError());
  return undefined_value(env);
}

static napi_value CanonicalPath(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "canonicalPath(fd)");
    return NULL;
  }
  HANDLE handle = NULL;
  if (get_handle_arg(env, args[0], &handle) != 0) return NULL;
  DWORD err = ERROR_SUCCESS;
  wchar_t *path = final_path(handle, &err);
  if (path == NULL) return throw_win32(env, "GetFinalPathNameByHandle", err);
  napi_value result;
  napi_create_string_utf16(env, (const char16_t *)path, wcslen(path), &result);
  free(path);
  return result;
}

static napi_value Fstat(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "fstat(fd)");
    return NULL;
  }
  HANDLE handle = NULL;
  if (get_handle_arg(env, args[0], &handle) != 0) return NULL;
  BY_HANDLE_FILE_INFORMATION data;
  if (!GetFileInformationByHandle(handle, &data)) {
    return throw_win32(env, "fstat", GetLastError());
  }
  bool is_directory = (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  bool is_file = !is_directory && GetFileType(handle) == FILE_TYPE_DISK;
  uint64_t index = ((uint64_t)data.nFileIndexHigh << 32) | data.nFileIndexLow;
  uint64_t size = ((uint64_t)data.nFileSizeHigh << 32) | data.nFileSizeLow;
  uint64_t ticks = ((uint64_t)data.ftLastWriteTime.dwHighDateTime << 32) |
                   data.ftLastWriteTime.dwLowDateTime;
  double mtime_ms = ticks > WINDOWS_TICK_UNIX_EPOCH
                        ? (double)(ticks - WINDOWS_TICK_UNIX_EPOCH) / 10000.0
                        : 0.0;
  char device[32];
  char inode[32];
  snprintf(device, sizeof(device), "%lu", (unsigned long)data.dwVolumeSerialNumber);
  snprintf(inode, sizeof(inode), "%llu", (unsigned long long)index);
  napi_value result;
  napi_value value;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, device, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "device", value);
  napi_create_string_utf8(env, inode, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "inode", value);
  napi_get_boolean(env, is_directory, &value);
  napi_set_named_property(env, result, "isDirectory", value);
  napi_get_boolean(env, is_file, &value);
  napi_set_named_property(env, result, "isFile", value);
  napi_get_boolean(env, false, &value);
  napi_set_named_property(env, result, "isSymbolicLink", value);
  napi_create_double(env, mtime_ms, &value);
  napi_set_named_property(env, result, "mtimeMs", value);
  napi_create_double(env, (double)size, &value);
  napi_set_named_property(env, result, "size", value);
  return result;
}

static napi_value Read(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 2) {
    napi_throw_type_error(env, NULL, "read(fd, size)");
    return NULL;
  }
  HANDLE handle = NULL;
  if (get_handle_arg(env, args[0], &handle) != 0) return NULL;
  int64_t requested = 0;
  if (napi_get_value_int64(env, args[1], &requested) != napi_ok || requested < 0 ||
      requested > INT32_MAX) {
    return throw_info(env, "read", E_INVAL);
  }
  size_t size = (size_t)requested;
  unsigned char *buffer = size > 0 ? malloc(size) : NULL;
  if (size > 0 && buffer == NULL) return throw_info(env, "read", E_NOMEM);
  size_t offset = 0;
  while (offset < size) {
    size_t remaining = size - offset;
    DWORD chunk = (DWORD)(remaining > READ_CHUNK ? READ_CHUNK : remaining);
    OVERLAPPED position;
    memset(&position, 0, sizeof(position));
    position.Offset = (DWORD)((uint64_t)offset & 0xFFFFFFFFu);
    position.OffsetHigh = (DWORD)((uint64_t)offset >> 32);
    DWORD got = 0;
    if (!ReadFile(handle, buffer + offset, chunk, &got, &position)) {
      DWORD err = GetLastError();
      if (err == ERROR_HANDLE_EOF) break;
      free(buffer);
      return throw_win32(env, "read", err);
    }
    if (got == 0) break;
    offset += got;
  }
  const unsigned char empty[1] = {0};
  napi_value result;
  napi_create_buffer_copy(env, offset, buffer != NULL ? buffer : empty, NULL, &result);
  free(buffer);
  return result;
}

static int next_dir_slot(void) {
  for (int index = 0; index < DIR_SLOTS; index += 1) {
    if (!dir_slots[index].used) return index;
  }
  return -1;
}

static napi_value DirOpen(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "dirOpen(fd)");
    return NULL;
  }
  HANDLE handle = NULL;
  if (get_handle_arg(env, args[0], &handle) != 0) return NULL;
  int slot = next_dir_slot();
  if (slot < 0) return throw_info(env, "dirOpen", E_MFILE);
  HANDLE directory = NULL;
  DWORD err = reopen_same(handle, FILE_LIST_DIRECTORY, SHARE_ALL, FILE_DIRECTORY_FILE, &directory);
  if (err != ERROR_SUCCESS &&
      !DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &directory, 0, FALSE,
                       DUPLICATE_SAME_ACCESS)) {
    return throw_win32(env, "dirOpen", err);
  }
  unsigned char *buffer = malloc(DIR_BUFFER_SIZE);
  if (buffer == NULL) {
    CloseHandle(directory);
    return throw_info(env, "dirOpen", E_NOMEM);
  }
  dir_slots[slot].used = 1;
  dir_slots[slot].handle = directory;
  dir_slots[slot].buffer = buffer;
  dir_slots[slot].offset = 0;
  dir_slots[slot].has_data = false;
  dir_slots[slot].started = false;
  dir_slots[slot].done = false;
  napi_value result;
  napi_create_int32(env, slot, &result);
  return result;
}

static napi_value DirRead(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "dirRead(dirId)");
    return NULL;
  }
  int dir_id = 0;
  if (get_slot_arg(env, args[0], &dir_id) != 0) return NULL;
  DirSlot *slot = &dir_slots[dir_id];
  if (!slot->used || slot->handle == NULL) return throw_info(env, "dirRead", E_INVAL);
  for (;;) {
    if (!slot->has_data) {
      if (slot->done) {
        napi_value null_value;
        napi_get_null(env, &null_value);
        return null_value;
      }
      FILE_INFO_BY_HANDLE_CLASS query =
          slot->started ? FileFullDirectoryInfo : FileFullDirectoryRestartInfo;
      slot->started = true;
      if (!GetFileInformationByHandleEx(slot->handle, query, slot->buffer, DIR_BUFFER_SIZE)) {
        DWORD err = GetLastError();
        if (err == ERROR_NO_MORE_FILES) {
          slot->done = true;
          continue;
        }
        return throw_win32(env, "readdir", err);
      }
      slot->has_data = true;
      slot->offset = 0;
    }
    FILE_FULL_DIR_INFO *entry = (FILE_FULL_DIR_INFO *)(slot->buffer + slot->offset);
    if (entry->NextEntryOffset == 0) {
      slot->has_data = false;
    } else {
      slot->offset += entry->NextEntryOffset;
    }
    size_t length = entry->FileNameLength / sizeof(WCHAR);
    if ((length == 1 && entry->FileName[0] == L'.') ||
        (length == 2 && entry->FileName[0] == L'.' && entry->FileName[1] == L'.')) {
      continue;
    }
    bool is_symlink = (entry->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 &&
                      IsReparseTagNameSurrogate(entry->EaSize);
    bool is_directory = !is_symlink && (entry->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    bool is_file = !is_symlink && !is_directory &&
                   (entry->FileAttributes & FILE_ATTRIBUTE_DEVICE) == 0;
    napi_value result;
    napi_value value;
    napi_create_object(env, &result);
    napi_create_string_utf16(env, (const char16_t *)entry->FileName, length, &value);
    napi_set_named_property(env, result, "name", value);
    napi_get_boolean(env, is_file, &value);
    napi_set_named_property(env, result, "isFile", value);
    napi_get_boolean(env, is_directory, &value);
    napi_set_named_property(env, result, "isDirectory", value);
    napi_get_boolean(env, is_symlink, &value);
    napi_set_named_property(env, result, "isSymbolicLink", value);
    return result;
  }
}

static napi_value DirClose(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "dirClose(dirId)");
    return NULL;
  }
  int dir_id = 0;
  if (get_slot_arg(env, args[0], &dir_id) != 0) return NULL;
  DirSlot *slot = &dir_slots[dir_id];
  if (!slot->used) return throw_info(env, "dirClose", E_INVAL);
  if (slot->handle != NULL) CloseHandle(slot->handle);
  free(slot->buffer);
  slot->handle = NULL;
  slot->buffer = NULL;
  slot->used = 0;
  return undefined_value(env);
}

static void builder_reserve(WideBuilder *builder, size_t extra) {
  if (builder->failed) return;
  if (builder->length + extra + 1 <= builder->capacity) return;
  size_t capacity = builder->capacity == 0 ? 256 : builder->capacity;
  while (capacity < builder->length + extra + 1) capacity *= 2;
  wchar_t *next = realloc(builder->data, capacity * sizeof(wchar_t));
  if (next == NULL) {
    builder->failed = true;
    return;
  }
  builder->data = next;
  builder->capacity = capacity;
}

static void builder_char(WideBuilder *builder, wchar_t value) {
  builder_reserve(builder, 1);
  if (builder->failed) return;
  builder->data[builder->length] = value;
  builder->length += 1;
  builder->data[builder->length] = L'\0';
}

static void builder_repeat(WideBuilder *builder, wchar_t value, size_t count) {
  for (size_t index = 0; index < count; index += 1) builder_char(builder, value);
}

static void builder_argument(WideBuilder *builder, const wchar_t *argument) {
  if (builder->length > 0) builder_char(builder, L' ');
  if (argument[0] != L'\0' && wcspbrk(argument, L" \t\n\v\"") == NULL) {
    for (const wchar_t *cursor = argument; *cursor != L'\0'; cursor += 1) {
      builder_char(builder, *cursor);
    }
    return;
  }
  builder_char(builder, L'"');
  const wchar_t *cursor = argument;
  for (;;) {
    size_t backslashes = 0;
    while (*cursor == L'\\') {
      backslashes += 1;
      cursor += 1;
    }
    if (*cursor == L'\0') {
      builder_repeat(builder, L'\\', backslashes * 2);
      break;
    }
    if (*cursor == L'"') {
      builder_repeat(builder, L'\\', backslashes * 2 + 1);
      builder_char(builder, L'"');
    } else {
      builder_repeat(builder, L'\\', backslashes);
      builder_char(builder, *cursor);
    }
    cursor += 1;
  }
  builder_char(builder, L'"');
}

static size_t env_name_length(const wchar_t *pair) {
  const wchar_t *equals = wcschr(pair[0] == L'=' ? pair + 1 : pair, L'=');
  return equals == NULL ? wcslen(pair) : (size_t)(equals - pair);
}

static int compare_env(const void *left, const void *right) {
  const wchar_t *a = *(const wchar_t *const *)left;
  const wchar_t *b = *(const wchar_t *const *)right;
  int result = CompareStringOrdinal(a, (int)env_name_length(a), b, (int)env_name_length(b), TRUE);
  return result - CSTR_EQUAL;
}

static bool is_git_env_pair(const wchar_t *pair) { return _wcsnicmp(pair, L"GIT_", 4) == 0; }

static wchar_t *build_environment(wchar_t **input, size_t count) {
  static const wchar_t *fixed[] = {
      L"GIT_CONFIG=/dev/null",
      L"GIT_CONFIG_GLOBAL=/dev/null",
      L"GIT_CONFIG_SYSTEM=/dev/null",
      L"GIT_CONFIG_NOSYSTEM=1",
  };
  size_t fixed_count = sizeof(fixed) / sizeof(fixed[0]);
  const wchar_t **entries = calloc(count + fixed_count + 1, sizeof(wchar_t *));
  if (entries == NULL) return NULL;
  size_t used = 0;
  for (size_t index = 0; index < fixed_count; index += 1) entries[used++] = fixed[index];
  for (size_t index = 0; index < count; index += 1) {
    if (input[index] == NULL || input[index][0] == L'\0' || is_git_env_pair(input[index])) {
      continue;
    }
    entries[used++] = input[index];
  }
  qsort((void *)entries, used, sizeof(wchar_t *), compare_env);
  size_t total = 1;
  for (size_t index = 0; index < used; index += 1) total += wcslen(entries[index]) + 1;
  wchar_t *block = malloc((total + 1) * sizeof(wchar_t));
  if (block == NULL) {
    free((void *)entries);
    return NULL;
  }
  size_t offset = 0;
  for (size_t index = 0; index < used; index += 1) {
    size_t length = wcslen(entries[index]);
    memcpy(block + offset, entries[index], length * sizeof(wchar_t));
    offset += length;
    block[offset++] = L'\0';
  }
  if (offset == 0) block[offset++] = L'\0';
  block[offset] = L'\0';
  free((void *)entries);
  return block;
}

static void free_wide_array(wchar_t **items, size_t count) {
  if (items == NULL) return;
  for (size_t index = 0; index < count; index += 1) free(items[index]);
  free(items);
}

static void free_git_request(GitRequest *request) {
  if (request == NULL) return;
  if (request->dir != NULL) CloseHandle(request->dir);
  free(request->file);
  free(request->command_line);
  free(request->environment);
  free(request->stdout_buf);
  free(request->stderr_buf);
  free(request);
}

static uint64_t git_token(int slot, uint64_t generation) {
  return (generation << 8) | (uint64_t)(unsigned int)slot;
}

static int git_token_slot(uint64_t token) { return (int)(token & 0xffu); }

static uint64_t git_token_generation(uint64_t token) { return token >> 8; }

static void fail_request(GitRequest *request, const char *what, DWORD err) {
  if (request->failed) return;
  request->failed = true;
  request->error_win32 = err;
  snprintf(request->error_msg, sizeof(request->error_msg), "%s", what);
}

static DWORD WINAPI pipe_reader(LPVOID parameter) {
  PipeReader *reader = parameter;
  unsigned char chunk[8192];
  for (;;) {
    DWORD got = 0;
    if (!ReadFile(reader->pipe, chunk, sizeof(chunk), &got, NULL)) break;
    if (got == 0) continue;
    unsigned char *next = NULL;
    if (reader->length + got <= reader->max_bytes) {
      next = realloc(reader->buffer, reader->length + got);
    }
    if (next == NULL) {
      InterlockedExchange(reader->overflow, 1);
      TerminateJobObject(reader->job, 1);
      break;
    }
    memcpy(next + reader->length, chunk, got);
    reader->buffer = next;
    reader->length += got;
  }
  return 0;
}

static void join_readers(HANDLE *threads, int count, DWORD grace_ms, HANDLE job) {
  if (count == 0) return;
  if (WaitForMultipleObjects((DWORD)count, threads, TRUE, grace_ms) == WAIT_OBJECT_0) return;
  TerminateJobObject(job, 1);
  if (WaitForMultipleObjects((DWORD)count, threads, TRUE, 1000) == WAIT_OBJECT_0) return;
  for (;;) {
    for (int index = 0; index < count; index += 1) CancelSynchronousIo(threads[index]);
    if (WaitForMultipleObjects((DWORD)count, threads, TRUE, 50) == WAIT_OBJECT_0) return;
  }
}

static void git_execute(napi_env env, void *data) {
  (void)env;
  GitRequest *request = data;
  HANDLE pin = NULL;
  HANDLE job = NULL;
  HANDLE out_read = NULL;
  HANDLE out_write = NULL;
  HANDLE err_read = NULL;
  HANDLE err_write = NULL;
  HANDLE null_input = INVALID_HANDLE_VALUE;
  HANDLE threads[2] = {NULL, NULL};
  int thread_count = 0;
  wchar_t *cwd = NULL;
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
  bool attributes_ready = false;
  PROCESS_INFORMATION process;
  memset(&process, 0, sizeof(process));
  volatile LONG overflow = 0;
  ULONGLONG deadline = 0;
  bool exited = false;
  PipeReader readers[2];
  memset(readers, 0, sizeof(readers));
  if (InterlockedCompareExchange(&request->cancelled, 0, 0) != 0) {
    request->cancelled_result = true;
    return;
  }
  DWORD err = reopen_same(request->dir, FILE_GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                          FILE_DIRECTORY_FILE, &pin);
  if (err != ERROR_SUCCESS) pin = NULL;
  err = ERROR_SUCCESS;
  cwd = final_path(pin != NULL ? pin : request->dir, &err);
  if (cwd == NULL) {
    fail_request(request, "GetFinalPathNameByHandle", err);
    goto cleanup;
  }
  if (!CreatePipe(&out_read, &out_write, NULL, 0) || !CreatePipe(&err_read, &err_write, NULL, 0)) {
    fail_request(request, "pipe", GetLastError());
    goto cleanup;
  }
  SECURITY_ATTRIBUTES inheritable;
  inheritable.nLength = sizeof(inheritable);
  inheritable.lpSecurityDescriptor = NULL;
  inheritable.bInheritHandle = TRUE;
  null_input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable,
                           OPEN_EXISTING, 0, NULL);
  if (null_input == INVALID_HANDLE_VALUE) {
    fail_request(request, "open NUL", GetLastError());
    goto cleanup;
  }
  job = CreateJobObjectW(NULL, NULL);
  if (job == NULL) {
    fail_request(request, "CreateJobObject", GetLastError());
    goto cleanup;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  memset(&limits, 0, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    fail_request(request, "SetInformationJobObject", GetLastError());
    goto cleanup;
  }
  SIZE_T attributes_size = 0;
  InitializeProcThreadAttributeList(NULL, 1, 0, &attributes_size);
  attributes = malloc(attributes_size);
  if (attributes == NULL) {
    fail_request(request, "InitializeProcThreadAttributeList", ERROR_NOT_ENOUGH_MEMORY);
    goto cleanup;
  }
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attributes_size)) {
    fail_request(request, "InitializeProcThreadAttributeList", GetLastError());
    goto cleanup;
  }
  attributes_ready = true;
  HANDLE inherited[3];
  inherited[0] = null_input;
  inherited[1] = out_write;
  inherited[2] = err_write;
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited,
                                 sizeof(inherited), NULL, NULL)) {
    fail_request(request, "UpdateProcThreadAttribute", GetLastError());
    goto cleanup;
  }
  STARTUPINFOEXW startup;
  memset(&startup, 0, sizeof(startup));
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = null_input;
  startup.StartupInfo.hStdOutput = out_write;
  startup.StartupInfo.hStdError = err_write;
  startup.lpAttributeList = attributes;
  SetHandleInformation(out_write, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  SetHandleInformation(err_write, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  BOOL created = CreateProcessW(request->file, request->command_line, NULL, NULL, TRUE,
                                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW |
                                    EXTENDED_STARTUPINFO_PRESENT,
                                request->environment, cwd, &startup.StartupInfo, &process);
  DWORD create_err = created ? ERROR_SUCCESS : GetLastError();
  CloseHandle(out_write);
  out_write = NULL;
  CloseHandle(err_write);
  err_write = NULL;
  CloseHandle(null_input);
  null_input = INVALID_HANDLE_VALUE;
  if (!created) {
    fail_request(request, "CreateProcess", create_err);
    goto cleanup;
  }
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    DWORD assign_err = GetLastError();
    TerminateProcess(process.hProcess, 1);
    fail_request(request, "AssignProcessToJobObject", assign_err);
    goto cleanup;
  }
  AcquireSRWLockExclusive(&git_lock);
  request->job = job;
  bool cancelled_early = InterlockedCompareExchange(&request->cancelled, 0, 0) != 0;
  ReleaseSRWLockExclusive(&git_lock);
  if (cancelled_early) TerminateJobObject(job, 1);
  readers[0].pipe = out_read;
  readers[1].pipe = err_read;
  for (int index = 0; index < 2; index += 1) {
    readers[index].job = job;
    readers[index].max_bytes = request->max_bytes;
    readers[index].overflow = &overflow;
    threads[index] = CreateThread(NULL, 0, pipe_reader, &readers[index], 0, NULL);
    if (threads[index] == NULL) {
      fail_request(request, "CreateThread", GetLastError());
      TerminateJobObject(job, 1);
      ResumeThread(process.hThread);
      goto join;
    }
    thread_count += 1;
  }
  ResumeThread(process.hThread);
  deadline = GetTickCount64() + (ULONGLONG)request->timeout_ms;
  for (;;) {
    if (InterlockedCompareExchange(&request->cancelled, 0, 0) != 0) {
      TerminateJobObject(job, 1);
      request->cancelled_result = true;
      break;
    }
    if (InterlockedCompareExchange(&overflow, 0, 0) != 0) {
      TerminateJobObject(job, 1);
      break;
    }
    ULONGLONG now = GetTickCount64();
    if (now >= deadline) {
      TerminateJobObject(job, 1);
      fail_request(request, "git status timed out", ERROR_SUCCESS);
      break;
    }
    ULONGLONG remaining = deadline - now;
    DWORD wait = WaitForSingleObject(process.hProcess, remaining > 100 ? 100 : (DWORD)remaining);
    if (wait == WAIT_OBJECT_0) {
      exited = true;
      break;
    }
    if (wait == WAIT_FAILED) {
      fail_request(request, "WaitForSingleObject", GetLastError());
      TerminateJobObject(job, 1);
      break;
    }
  }
  if (!exited) WaitForSingleObject(process.hProcess, 5000);
join: {
  ULONGLONG now = GetTickCount64();
  DWORD grace = 0;
  if (exited && !request->failed && now < deadline) {
    ULONGLONG left = deadline - now;
    grace = left > 0xFFFFFFF0ull ? 0xFFFFFFF0u : (DWORD)left;
  }
  join_readers(threads, thread_count, grace, job);
}
  if (InterlockedCompareExchange(&overflow, 0, 0) != 0 && !request->cancelled_result) {
    request->failed = false;
    fail_request(request, "Git output exceeded the Native Files limit", ERROR_SUCCESS);
  }
  if (InterlockedCompareExchange(&request->cancelled, 0, 0) != 0) request->cancelled_result = true;
  if (exited && !request->failed && !request->cancelled_result) {
    DWORD exit_code = 1;
    if (!GetExitCodeProcess(process.hProcess, &exit_code)) exit_code = 1;
    request->code = (int)exit_code;
  }
  request->stdout_buf = readers[0].buffer;
  request->stdout_len = readers[0].length;
  readers[0].buffer = NULL;
  request->stderr_buf = readers[1].buffer;
  request->stderr_len = readers[1].length;
  readers[1].buffer = NULL;

cleanup:
  for (int index = 0; index < 2; index += 1) {
    if (threads[index] != NULL) CloseHandle(threads[index]);
    free(readers[index].buffer);
  }
  if (process.hThread != NULL) CloseHandle(process.hThread);
  if (process.hProcess != NULL) CloseHandle(process.hProcess);
  if (out_read != NULL) CloseHandle(out_read);
  if (out_write != NULL) CloseHandle(out_write);
  if (err_read != NULL) CloseHandle(err_read);
  if (err_write != NULL) CloseHandle(err_write);
  if (null_input != INVALID_HANDLE_VALUE) CloseHandle(null_input);
  if (attributes_ready) DeleteProcThreadAttributeList(attributes);
  free(attributes);
  if (job != NULL) {
    AcquireSRWLockExclusive(&git_lock);
    request->job = NULL;
    ReleaseSRWLockExclusive(&git_lock);
    CloseHandle(job);
  }
  if (pin != NULL) CloseHandle(pin);
  free(cwd);
}

static void git_complete(napi_env env, napi_status status, void *data) {
  GitRequest *request = data;
  napi_deferred deferred = request->deferred;
  napi_async_work work = request->work;
  AcquireSRWLockExclusive(&git_lock);
  if (request->slot >= 0 && request->slot < GIT_SLOTS && git_slots[request->slot] == request) {
    git_slots[request->slot] = NULL;
  }
  ReleaseSRWLockExclusive(&git_lock);
  if (status != napi_ok) {
    napi_value message;
    napi_value error;
    napi_create_string_utf8(env, "Git worker cancelled", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, NULL, message, &error);
    napi_reject_deferred(env, deferred, error);
  } else if (request->cancelled_result) {
    napi_value code_val;
    napi_value message_val;
    napi_value error;
    napi_create_string_utf8(env, "ABORT", NAPI_AUTO_LENGTH, &code_val);
    napi_create_string_utf8(env, "Git operation cancelled", NAPI_AUTO_LENGTH, &message_val);
    napi_create_error(env, code_val, message_val, &error);
    napi_set_named_property(env, error, "code", code_val);
    napi_reject_deferred(env, deferred, error);
  } else if (request->failed) {
    if (request->error_win32 != ERROR_SUCCESS) {
      throw_win32(env, request->error_msg, request->error_win32);
    } else {
      ErrorInfo info;
      info.code = "EIO";
      info.message = request->error_msg;
      throw_info(env, "git", info);
    }
    napi_value pending;
    napi_get_and_clear_last_exception(env, &pending);
    napi_reject_deferred(env, deferred, pending);
  } else {
    napi_value result;
    napi_value code;
    napi_value stdout_val;
    napi_value stderr_val;
    const unsigned char empty[1] = {0};
    napi_create_object(env, &result);
    napi_create_int32(env, request->code, &code);
    napi_create_buffer_copy(env, request->stdout_len,
                            request->stdout_buf != NULL ? request->stdout_buf : empty, NULL,
                            &stdout_val);
    napi_create_buffer_copy(env, request->stderr_len,
                            request->stderr_buf != NULL ? request->stderr_buf : empty, NULL,
                            &stderr_val);
    napi_set_named_property(env, result, "code", code);
    napi_set_named_property(env, result, "stdout", stdout_val);
    napi_set_named_property(env, result, "stderr", stderr_val);
    napi_resolve_deferred(env, deferred, result);
  }
  napi_delete_async_work(env, work);
  request->work = NULL;
  request->deferred = NULL;
  free_git_request(request);
}

static napi_value CancelGit(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "cancelGit(id)");
    return NULL;
  }
  int64_t token = 0;
  if (napi_get_value_int64(env, args[0], &token) != napi_ok || token < 0) {
    napi_throw_type_error(env, NULL, "cancelGit(id)");
    return NULL;
  }
  int slot = git_token_slot((uint64_t)token);
  uint64_t generation = git_token_generation((uint64_t)token);
  AcquireSRWLockExclusive(&git_lock);
  if (slot >= 0 && slot < GIT_SLOTS && git_slots[slot] != NULL &&
      git_slots[slot]->generation == generation) {
    InterlockedExchange(&git_slots[slot]->cancelled, 1);
    if (git_slots[slot]->job != NULL) TerminateJobObject(git_slots[slot]->job, 1);
  }
  ReleaseSRWLockExclusive(&git_lock);
  return undefined_value(env);
}

static wchar_t **get_wide_array(napi_env env, napi_value value, uint32_t *count_out) {
  bool is_array = false;
  if (napi_is_array(env, value, &is_array) != napi_ok || !is_array) return NULL;
  uint32_t count = 0;
  napi_get_array_length(env, value, &count);
  wchar_t **items = calloc((size_t)count + 1, sizeof(wchar_t *));
  if (items == NULL) return NULL;
  for (uint32_t index = 0; index < count; index += 1) {
    napi_value item;
    napi_get_element(env, value, index, &item);
    items[index] = get_wide_string(env, item, NULL);
    if (items[index] == NULL) {
      free_wide_array(items, index);
      return NULL;
    }
  }
  *count_out = count;
  return items;
}

static napi_value GitStatusAt(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value args[6];
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 5) {
    napi_throw_type_error(env, NULL, "gitStatusAt(dirfd, file, args, timeoutMs, maxBytes, env)");
    return NULL;
  }
  HANDLE dir = NULL;
  if (get_handle_arg(env, args[0], &dir) != 0) return NULL;
  GitRequest *request = calloc(1, sizeof(*request));
  if (request == NULL) return throw_info(env, "gitStatusAt", E_NOMEM);
  request->slot = -1;
  if (!DuplicateHandle(GetCurrentProcess(), dir, GetCurrentProcess(), &request->dir, 0, FALSE,
                       DUPLICATE_SAME_ACCESS)) {
    DWORD err = GetLastError();
    request->dir = NULL;
    free_git_request(request);
    return throw_win32(env, "dup", err);
  }
  request->file = get_wide_string(env, args[1], NULL);
  if (request->file == NULL) {
    free_git_request(request);
    napi_throw_type_error(env, NULL, "file must be a string");
    return NULL;
  }
  uint32_t arg_count = 0;
  wchar_t **arguments = get_wide_array(env, args[2], &arg_count);
  if (arguments == NULL) {
    free_git_request(request);
    napi_throw_type_error(env, NULL, "args must be an array of strings");
    return NULL;
  }
  WideBuilder builder;
  memset(&builder, 0, sizeof(builder));
  builder_argument(&builder, request->file);
  for (uint32_t index = 0; index < arg_count; index += 1) {
    builder_argument(&builder, arguments[index]);
  }
  free_wide_array(arguments, arg_count);
  if (builder.failed || builder.data == NULL) {
    free(builder.data);
    free_git_request(request);
    return throw_info(env, "gitStatusAt", E_NOMEM);
  }
  request->command_line = builder.data;
  int64_t timeout_ms = 0;
  int64_t max_bytes = 0;
  napi_get_value_int64(env, args[3], &timeout_ms);
  napi_get_value_int64(env, args[4], &max_bytes);
  if (timeout_ms <= 0 || timeout_ms > INT32_MAX || max_bytes <= 0) {
    free_git_request(request);
    return throw_info(env, "gitStatusAt", E_INVAL);
  }
  request->timeout_ms = (int)timeout_ms;
  request->max_bytes = (size_t)max_bytes;
  wchar_t **environment = NULL;
  uint32_t env_count = 0;
  if (argc >= 6) {
    environment = get_wide_array(env, args[5], &env_count);
    if (environment == NULL) {
      free_git_request(request);
      napi_throw_type_error(env, NULL, "env must be an array of strings");
      return NULL;
    }
  }
  request->environment = build_environment(environment, env_count);
  free_wide_array(environment, env_count);
  if (request->environment == NULL) {
    free_git_request(request);
    return throw_info(env, "gitStatusAt", E_NOMEM);
  }
  AcquireSRWLockExclusive(&git_lock);
  int slot = -1;
  for (int index = 0; index < GIT_SLOTS; index += 1) {
    if (git_slots[index] == NULL) {
      slot = index;
      break;
    }
  }
  if (slot < 0) {
    ReleaseSRWLockExclusive(&git_lock);
    free_git_request(request);
    return throw_info(env, "gitStatusAt", E_MFILE);
  }
  request->slot = slot;
  request->generation = (uint64_t)InterlockedIncrement64(&git_generation);
  git_slots[slot] = request;
  ReleaseSRWLockExclusive(&git_lock);
  napi_value promise;
  if (napi_create_promise(env, &request->deferred, &promise) != napi_ok) {
    AcquireSRWLockExclusive(&git_lock);
    git_slots[slot] = NULL;
    ReleaseSRWLockExclusive(&git_lock);
    free_git_request(request);
    napi_throw_error(env, NULL, "Failed to create git promise");
    return NULL;
  }
  napi_value work_name;
  napi_create_string_utf8(env, "host_native_files.gitStatusAt", NAPI_AUTO_LENGTH, &work_name);
  if (napi_create_async_work(env, NULL, work_name, git_execute, git_complete, request,
                             &request->work) != napi_ok ||
      napi_queue_async_work(env, request->work) != napi_ok) {
    AcquireSRWLockExclusive(&git_lock);
    git_slots[slot] = NULL;
    ReleaseSRWLockExclusive(&git_lock);
    napi_value message;
    napi_value error;
    napi_create_string_utf8(env, "Failed to queue git work", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, NULL, message, &error);
    napi_reject_deferred(env, request->deferred, error);
    free_git_request(request);
    return NULL;
  }
  napi_value result;
  napi_value id_val;
  napi_create_object(env, &result);
  napi_create_int64(env, (int64_t)git_token(slot, request->generation), &id_val);
  napi_set_named_property(env, result, "id", id_val);
  napi_set_named_property(env, result, "promise", promise);
  return result;
}

static napi_value SupportsOpenat2(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  napi_get_boolean(env, false, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll != NULL) {
    nt_create_file = (NtCreateFileFn)GetProcAddress(ntdll, "NtCreateFile");
    rtl_nt_status_to_dos_error =
        (RtlNtStatusToDosErrorFn)GetProcAddress(ntdll, "RtlNtStatusToDosError");
  }
  struct {
    const char *name;
    napi_callback callback;
  } functions[] = {
      {"open", Open},
      {"openat", Openat},
      {"dup", Dup},
      {"close", CloseFd},
      {"canonicalPath", CanonicalPath},
      {"fstat", Fstat},
      {"read", Read},
      {"dirOpen", DirOpen},
      {"dirRead", DirRead},
      {"dirClose", DirClose},
      {"gitStatusAt", GitStatusAt},
      {"cancelGit", CancelGit},
      {"supportsOpenat2", SupportsOpenat2},
  };
  for (size_t index = 0; index < sizeof(functions) / sizeof(functions[0]); index += 1) {
    napi_value fn;
    napi_create_function(env, functions[index].name, NAPI_AUTO_LENGTH, functions[index].callback,
                         NULL, &fn);
    napi_set_named_property(env, exports, functions[index].name, fn);
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
