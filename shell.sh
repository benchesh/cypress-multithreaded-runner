#!/bin/bash

cypressConfigFilepath="$2"
thread="$3"
threadNo="$4"
allureResultsPath="$1/$threadNo"
additionalCypressEnvArgs="$5"

cypress run --config-file "$cypressConfigFilepath" --e2e --config="$thread" --env allure=true,allureResults="$allureResultsPath""$additionalCypressEnvArgs"

echo Thread \#"$threadNo" has completed.
