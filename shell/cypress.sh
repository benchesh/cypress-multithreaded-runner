#!/bin/bash

cypressConfigFilepath="$2"
thread="$3"
threadNo="$4"
allureResultsPath="$1/$threadNo"

if [[ "$5" == "" ]]; then
    browser=""
else
    browser="--browser $5"
fi

additionalCypressEnvArgs="$7"

if [[ "$6" == "" ]]; then
    cypress run $browser --config-file "$cypressConfigFilepath" --e2e --config="$thread" --env allure=true,allureAddVideoOnPass=true,allureResults="$allureResultsPath""$additionalCypressEnvArgs"
else
    cypress run $browser --config-file "$cypressConfigFilepath" --reporter junit --reporter-options="{\"mochaFile\":\"$6\"}" --e2e --config="$thread" --env allure=true,allureAddVideoOnPass=true,allureResults="$allureResultsPath""$additionalCypressEnvArgs"
fi

echo Thread \#"$threadNo" has completed.

echo "<FALLBACK_SHELL_EXIT>"
