{
  "targets": [
    {
      "target_name": "host_native_files",
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        [
          "OS=='win'",
          {
            "sources": ["host_native_files_win.c"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "WarningLevel": "3",
                "WarnAsError": "true"
              }
            }
          },
          {
            "sources": ["host_native_files.c"],
            "cflags": ["-fvisibility=hidden", "-Wall", "-Wextra", "-Werror"],
            "cflags_c": ["-std=c11"],
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
              "CLANG_CXX_LIBRARY": "libc++",
              "MACOSX_DEPLOYMENT_TARGET": "11.0",
              "OTHER_CFLAGS": ["-fvisibility=hidden", "-Wall", "-Wextra", "-Werror"]
            }
          }
        ]
      ]
    }
  ]
}
